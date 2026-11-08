import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Database } from "@vectordevai/core/database/database"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import type { ModelCatalog } from "@vectordevai/core/model-catalog"
import type { SubagentRecord } from "../../src/agent/subagent-kind"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Question } from "../../src/question"
import { Session } from "@/session/session"
import { SessionFork } from "../../src/session/fork"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { TaskLimits } from "@/task/limits"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { pollWithTimeout, testEffect } from "../lib/effect"

// A fork reads its parent's prompt cache (multi-agent contract 5.E.3, I24): while the parent's step is cached its first
// request repeats that step's tools, both system blocks and every message before the fork point; forks launched by one
// response differ only in their assignment; the root's cache key goes on a run's first request only, while the session
// headers stay the fork's own; a cold fork is told and offered what its parent was; and a fork's own history reloads
// keep what it inherited.

type Body = Record<string, any>
type Hit = { path: string; body: Body; headers: Record<string, string> }

const server = {
  current: null as ReturnType<typeof Bun.serve> | null,
  hits: [] as Hit[],
  // How each request is answered.
  answer: (_hit: Hit): Response => new Response("unscripted", { status: 400 }),
}

const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + "\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  })

let calls = 0
type Block = { text: string } | { tool: string; input: unknown }

// An Anthropic Messages stream with the given content blocks.
function anthropic(...blocks: Block[]) {
  const usage = { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null }
  const events: unknown[] = [{ type: "message_start", message: { id: "msg-fake", model: "claude-opus-4-6", usage } }]
  for (const [index, block] of blocks.entries()) {
    if ("text" in block)
      events.push(
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      )
    else
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: `toolu_${++calls}`, name: block.tool, input: {} },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      )
    events.push({ type: "content_block_stop", index })
  }
  const tools = blocks.some((block) => "tool" in block)
  events.push(
    { type: "message_delta", delta: { stop_reason: tools ? "tool_use" : "end_turn", stop_sequence: null }, usage },
    { type: "message_stop" },
  )
  return sse(events)
}

// An OpenAI-compatible chat completions stream with text or one tool call.
function chat(block: Block) {
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "coder" }
  const delta =
    "text" in block
      ? { role: "assistant", content: block.text }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${++calls}`,
              type: "function",
              function: { name: block.tool, arguments: JSON.stringify(block.input) },
            },
          ],
        }
  return new Response(
    [
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "text" in block ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}`)
      .concat("data: [DONE]")
      .join("\n\n") + "\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  )
}

beforeAll(() => {
  server.current = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = (await request.json().catch(() => ({}))) as Body
      const hit = { path: url.pathname, body, headers: Object.fromEntries(request.headers.entries()) }
      server.hits.push(hit)
      return server.answer(hit)
    },
  })
})

beforeEach(() => {
  server.hits = []
})

afterAll(() => {
  void server.current?.stop()
})

const origin = () => server.current!.url.origin
const text = (hit: Hit) => JSON.stringify(hit.body.messages ?? [])
const isFork = (hit: Hit) => text(hit).includes("<fork_assignment>")
// Titles and other helpers are sent without tools.
const helper = (hit: Hit) => !Array.isArray(hit.body.tools) || hit.body.tools.length === 0

/** A request body without cache markers: where breakpoints go is the only thing a fork may change. */
function unmarked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarked)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, item]) => [key, unmarked(item)]),
    )
  return value
}

const MODELS = JSON.parse(
  await Bun.file(path.join(import.meta.dir, "../tool/fixtures/models-api.json")).text(),
) as Record<string, ModelCatalog.Provider>
const OPUS = "claude-opus-4-6"
const opus = { providerID: ProviderV2.ID.make("anthropic"), modelID: ModelV2.ID.make(OPUS) }
const coder = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("coder") }

function opusModel() {
  const model = MODELS.anthropic!.models[OPUS]!
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

const anthropicConfig =
  (extra: Partial<ConfigV1.Info> = {}) =>
  (): Partial<ConfigV1.Info> => ({
    formatter: false,
    lsp: false,
    enabled_providers: ["anthropic"],
    provider: {
      anthropic: {
        name: "Anthropic",
        env: ["ANTHROPIC_API_KEY"],
        npm: "@ai-sdk/anthropic",
        api: "https://api.anthropic.com/v1",
        models: { [OPUS]: opusModel() as ConfigModel },
        options: { apiKey: "test-anthropic-key", baseURL: `${origin()}/v1` },
      },
    },
    ...extra,
  })

// A local $0 model on a server that routes by prompt cache key, as OpenAI does.
const localConfig = (): Partial<ConfigV1.Info> => ({
  formatter: false,
  lsp: false,
  enabled_providers: ["lmstudio"],
  provider: {
    lmstudio: {
      name: "Local",
      id: "lmstudio",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        coder: {
          id: "coder",
          name: "Coder",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
        },
      },
      options: { apiKey: "test-key", baseURL: `${origin()}/v1`, setCacheKey: true },
    },
  },
})

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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPrompt.node,
      SessionFork.node,
      Session.node,
      SessionStatus.node,
      Question.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      TaskLimits.node,
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, noteQuietMs: 50, noteHoldMs: 300 })],
    ],
  ),
)

const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]

const ask = Effect.fn("ForkCacheTest.ask")(function* (
  sessionID: SessionID,
  model: { providerID: ProviderV2.ID; modelID: ModelV2.ID },
  words: string,
) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt.prompt({
    sessionID,
    agent: "build",
    model,
    size: "standard",
    parts: [{ type: "text", text: words }],
  })
})

const forkHits = (count: number) =>
  pollWithTimeout(
    Effect.sync(() => {
      const found = server.hits.filter(isFork)
      return found.length >= count ? found : undefined
    }),
    `${count} fork requests must arrive`,
    "20 seconds",
  )

/**
 * A fork child of `root` at `point`, as the task tool records one, prompted with its assignment: the cold path, since
 * no step of `root` kept a prefix for `point` by then.
 */
const coldFork = Effect.fn("ForkCacheTest.coldFork")(function* (
  root: SessionID,
  point: MessageID,
  assignment: string,
  // Writes the fork's own history first; the assignment is then a plain follow-up.
  own?: (child: SessionID, from: MessageID) => Effect.Effect<void>,
) {
  const sessions = yield* Session.Service
  const forks = yield* SessionFork.Service
  const from = MessageID.ascending()
  const record: SubagentRecord = {
    kind: "specialist",
    agent: "build",
    custom: false,
    title: "Cold fork",
    parentSessionID: root,
    parentMessageID: point,
    startedAt: Date.now(),
    status: "running",
    background: true,
    attempt: 1,
    model: { providerID: opus.providerID, modelID: opus.modelID },
    modelSource: "fork",
    fork: { point, from },
  }
  const child = yield* sessions.create({
    parentID: root,
    agent: "build",
    title: "Cold fork (@fork subagent)",
    metadata: { [SubagentLifecycle.METADATA_KEY]: record },
    permission: [...allowAll, ...SessionFork.FORK_DENIES({})],
  })
  const shape = yield* forks.userFields(record)
  if (own) yield* own(child.id, from)
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({
    sessionID: child.id,
    ...(own ? {} : { messageID: from }),
    agent: "build",
    model: shape.model,
    ...(shape.system !== undefined ? { system: shape.system } : {}),
    parts: [{ type: "text", text: own ? assignment : SessionFork.directive({ prompt: assignment }) }],
  })
  return child
})

describe("a warm fork reads its parent's cache", () => {
  it.instance(
    "its first request equals the parent's on tools, system and messages before the point; two forks differ only in their assignment",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        server.answer = (hit) => {
          if (helper(hit)) return anthropic({ text: "Title" })
          if (isFork(hit)) return anthropic({ text: "Fork done." })
          if (text(hit).includes("tool_result")) return anthropic({ text: "Launched two forks." })
          return anthropic(
            { tool: "task", input: { description: "Fix the parser", prompt: "FORK_A: fix the parser.", fork: true } },
            { tool: "task", input: { description: "Fix the printer", prompt: "FORK_B: fix the printer.", fork: true } },
          )
        }
        const root = yield* sessions.create({ title: "Forks", permission: allowAll })
        yield* ask(root.id, opus, "PARENT_REQUEST: fix the parser and the printer.")
        const [a, b] = yield* forkHits(2)
        const parent = server.hits.find((hit) => !helper(hit) && !isFork(hit))!
        // Both carry both briefs in the launching response; each one's own is its last block.
        const assignment = (hit: Hit) => JSON.stringify(hit.body.messages.at(-1).content.at(-1))
        const [one, two] = assignment(a!).includes("FORK_A") ? [a!, b!] : [b!, a!]

        expect(parent.body.messages).toHaveLength(1)
        // Both system blocks, and the size note the parent's step sent with its request.
        expect(parent.body.system).toHaveLength(2)
        expect(JSON.stringify(parent.body.messages[0])).toContain("<task_size>")
        for (const fork of [one, two]) {
          expect(unmarked(fork.body.tools)).toEqual(unmarked(parent.body.tools))
          expect(unmarked(fork.body.system)).toEqual(unmarked(parent.body.system))
          expect(unmarked(fork.body.messages.slice(0, parent.body.messages.length))).toEqual(
            unmarked(parent.body.messages),
          )
        }
        // The two forks share everything up to their own assignment, cache markers included.
        expect(one.body.tools).toEqual(two.body.tools)
        expect(one.body.system).toEqual(two.body.system)
        expect(one.body.messages.slice(0, -1)).toEqual(two.body.messages.slice(0, -1))
        const last = (hit: Hit) => hit.body.messages.at(-1).content as Body[]
        expect(unmarked(last(one).slice(0, -1))).toEqual(unmarked(last(two).slice(0, -1)))
        expect(JSON.stringify(last(one).at(-1))).toContain("FORK_A")
        expect(JSON.stringify(last(two).at(-1))).toContain("FORK_B")
        // Every local tool call in the launching response reads the same to each fork.
        expect(JSON.stringify(last(one))).toContain(SessionFork.TASK_PLACEHOLDER)
        // The last inherited message takes the non-final breakpoint, from which the provider finds the parent's entry.
        expect(
          last(one)
            .filter((block) => block.type === "tool_result")
            .at(-1)?.cache_control,
        ).toBeDefined()
        // Each fork recorded that it ran warm.
        for (const child of yield* sessions.children(root.id))
          expect(SubagentLifecycle.read(child)?.fork).toMatchObject({ warm: true })
      }),
    { trusted: true, config: anthropicConfig() },
    60_000,
  )

  it.instance(
    "the root's cache key goes on a run's first request only, and the session headers stay the fork's",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        server.answer = (hit) => {
          if (helper(hit)) return chat({ text: "Title" })
          if (isFork(hit))
            // The fork tries to launch a subagent of its own, which it may not, then answers.
            return text(hit).includes("is not available in a fork")
              ? chat({ text: "Fork done." })
              : chat({ tool: "task", input: { description: "Nested", prompt: "Launch another." } })
          if (text(hit).includes('"tool"')) return chat({ text: "Launched a fork." })
          return chat({ tool: "task", input: { description: "Fix the parser", prompt: "FORK_KEY", fork: true } })
        }
        const root = yield* sessions.create({ title: "Forks", permission: allowAll })
        yield* ask(root.id, coder, "PARENT_REQUEST: fix the parser.")
        const [first, second] = yield* forkHits(2)
        const [child] = yield* sessions.children(root.id)
        expect(first!.body.promptCacheKey).toBe(root.id)
        expect(second!.body.promptCacheKey).toBe(child!.id)
        expect(text(second!)).toContain(SessionFork.refusal("task"))
        for (const hit of [first!, second!])
          expect(hit.headers).toMatchObject({
            "x-session-affinity": child!.id,
            "x-parent-session-id": root.id,
            "x-session-id": child!.id,
          })
        const parent = server.hits.find((hit) => !helper(hit) && !isFork(hit))!
        expect(parent.body.promptCacheKey).toBe(root.id)
      }),
    { trusted: true, config: localConfig },
    60_000,
  )
})

describe("a cold fork", () => {
  it.instance(
    "carries the same instructions and tool names as its parent's step",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        server.answer = (hit) => (helper(hit) ? anthropic({ text: "Title" }) : anthropic({ text: "Answered." }))
        const root = yield* sessions.create({ title: "Cold", permission: allowAll })
        yield* ask(root.id, opus, "PARENT_REQUEST: explain the parser.")
        const point = (yield* sessions.messages({ sessionID: root.id })).find(
          (message) => message.info.role === "assistant",
        )!.info.id
        // A later step keeps its own prefix, which replaces the first one's.
        yield* ask(root.id, opus, "SECOND_REQUEST: and the printer?")
        const child = yield* coldFork(root.id, point, "COLD_FORK: fix the parser.")
        const parent = server.hits.find((hit) => !helper(hit) && text(hit).includes("PARENT_REQUEST"))!
        const fork = server.hits.find((hit) => text(hit).includes("COLD_FORK"))!
        expect(unmarked(fork.body.system)).toEqual(unmarked(parent.body.system))
        const names = (hit: Hit) => (hit.body.tools as Body[]).map((tool) => tool.name).toSorted()
        expect(names(fork)).toEqual(names(parent))
        expect(unmarked(fork.body.messages[0])).toEqual(unmarked(parent.body.messages[0]))
        expect(text(fork)).not.toContain("SECOND_REQUEST")
        expect(SubagentLifecycle.read(yield* sessions.get(child.id))?.fork).toMatchObject({ warm: false })
      }),
    { trusted: true, config: anthropicConfig() },
    60_000,
  )

  it.instance(
    "with compaction.clear on, the inherited history is still sent after its own old tool output is cleared",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        server.answer = (hit) => (helper(hit) ? anthropic({ text: "Title" }) : anthropic({ text: "Answered." }))
        const root = yield* sessions.create({ title: "Clear", permission: allowAll })
        yield* ask(root.id, opus, "PARENT_REQUEST: explain the parser.")
        const point = (yield* sessions.messages({ sessionID: root.id })).find(
          (message) => message.info.role === "assistant",
        )!.info.id
        const BIG = "x".repeat(200_000)
        // The fork's own history: its assignment, a step whose tool output is large, and a step that reported a large
        // request, so the next request clears the old output first.
        yield* coldFork(root.id, point, "FOLLOW_UP: carry on.", (child, from) =>
          Effect.gen(function* () {
            const now = Date.now()
            yield* sessions.updateMessage({
              id: from,
              role: "user",
              sessionID: child,
              agent: "build",
              model: opus,
              time: { created: now },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: from,
              sessionID: child,
              type: "text",
              text: SessionFork.directive({ prompt: "FORK_CLEAR: read the parser." }),
            })
            const step = (tokens: number, finish: string): SessionV1.Assistant => ({
              id: MessageID.ascending(),
              role: "assistant",
              parentID: from,
              sessionID: child,
              mode: "build",
              agent: "build",
              cost: 0,
              path: { cwd: "/", root: "/" },
              tokens: { input: tokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: opus.modelID,
              providerID: opus.providerID,
              time: { created: Date.now(), completed: Date.now() },
              finish,
            })
            const read = yield* sessions.updateMessage(step(1_000, "tool-calls"))
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: read.id,
              sessionID: child,
              type: "tool",
              tool: "shell",
              callID: "toolu_big",
              state: {
                status: "completed",
                input: { command: "cat parser.ts" },
                output: BIG,
                title: "cat parser.ts",
                metadata: {},
                time: { start: now, end: now },
              },
            })
            const answered = yield* sessions.updateMessage(step(70_000, "stop"))
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: answered.id,
              sessionID: child,
              type: "text",
              text: "Read it.",
            })
          }),
        )
        const fork = server.hits.find((hit) => text(hit).includes("FOLLOW_UP"))!
        expect(text(fork)).toContain("PARENT_REQUEST")
        expect(text(fork)).toContain("FORK_CLEAR")
        expect(text(fork)).toContain("[Old tool result content cleared]")
        expect(text(fork)).not.toContain(BIG.slice(0, 1_000))
      }),
    { trusted: true, config: anthropicConfig({ compaction: { clear: true } }) },
    60_000,
  )
})
