import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { TaskNotify } from "@/task/notify"
import { TaskLimits } from "@/task/limits"
import { TaskManager } from "@/task/manager"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { isRecord } from "@/util/record"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

// A brief's own model and effort (multi-agent contract 5.E.1): they reach the child's prompt, its record and the task
// part; a Thorough parent's general child runs at high effort through the sized path; a batch takes them per entry.

afterEach(async () => {
  await disposeAllInstances()
})

const lmstudio = ProviderV2.ID.make("lmstudio")
const ref = (modelID: string) => ({ providerID: lmstudio, modelID: ModelV2.ID.make(modelID) })

const tools = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionRevert.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      Provider.node,
      SpendGuard.node,
      TaskNotify.node,
      TaskLimits.node,
      TaskManager.node,
      FreeModelGuests.node,
      BackgroundJobStore.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ noteQuietMs: 300, noteHoldMs: 1_000 })]],
  ),
)

const priced = {
  provider: {
    lmstudio: {
      name: "Test",
      id: "lmstudio",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
      models: Object.fromEntries(
        (
          [
            ["big", { input: 3, output: 15 }],
            ["mid", { input: 1, output: 5 }],
            ["pricey", { input: 10, output: 50 }],
          ] as const
        ).map(([id, cost]) => [
          id,
          {
            id,
            name: id,
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost,
            variants: { low: {}, medium: {}, high: {} },
          },
        ]),
      ),
    },
  },
}

const seed = Effect.fn("TaskModelEffortTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Pinned" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref("big"),
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref("big").modelID,
    providerID: lmstudio,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(prompts: SessionPrompt.PromptInput[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        prompts.push(input)
        const id = MessageID.ascending()
        return {
          info: {
            id,
            role: "assistant",
            parentID: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            mode: input.agent ?? "general",
            agent: input.agent ?? "general",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: input.model?.modelID ?? ref("big").modelID,
            providerID: input.model?.providerID ?? lmstudio,
            time: { created: Date.now() },
            finish: "stop",
          },
          parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "done" }],
        } satisfies SessionV1.WithParts
      }),
  }
}

function context(input: { sessionID: SessionID; messageID: MessageID; ops: TaskPromptOps; asks: unknown[] }) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: "call_task",
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps: input.ops },
    messages: [],
    metadata: () => Effect.void,
    ask: (request: unknown) =>
      Effect.sync(() => {
        input.asks.push(request)
      }),
  }
}

describe("task model and effort", () => {
  tools.instance(
    "a brief's model and effort reach the child's prompt, its record and the task part; a refused one asks nothing",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const asks: unknown[] = []
        const ctx = context({ sessionID: chat.id, messageID: assistant.id, ops: stubOps(prompts), asks })
        const brief = { description: "map handlers", prompt: "Map the HTTP handlers.", background: false }

        const result = yield* def.execute({ ...brief, model: "lmstudio/mid", effort: "low" }, ctx)
        expect(prompts).toHaveLength(1)
        expect(prompts[0]!.model).toEqual(ref("mid"))
        expect(prompts[0]!.variant).toBe("low")
        expect(result.metadata).toMatchObject({
          model: { ...ref("mid"), variant: "low" },
          effort: "low",
          modelSource: "call",
        })
        const [child] = yield* sessions.children(chat.id)
        expect(SubagentLifecycle.read(child!)).toMatchObject({
          model: { ...ref("mid"), variant: "low" },
          effort: "low",
          modelSource: "call",
        })

        // A pricier model than the parent's, with no allow list, is refused before the ask and before any child.
        const exit = yield* Effect.exit(def.execute({ ...brief, model: "lmstudio/pricey" }, ctx))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain("lmstudio/pricey costs more than your model")
        // So is an effort above the parent's own: big defaults to medium.
        const high = yield* Effect.exit(def.execute({ ...brief, effort: "high" }, ctx))
        expect(Exit.isFailure(high)).toBe(true)
        if (Exit.isFailure(high)) expect(Cause.pretty(high.cause)).toContain("Effort high is above your own (medium)")
        expect(asks).toHaveLength(1)
        expect(prompts).toHaveLength(1)
        expect(yield* sessions.children(chat.id)).toHaveLength(1)

        // Without either, a child runs on the parent's model, and the part says so.
        const plain = yield* def.execute(brief, ctx)
        expect(prompts[1]!.model).toEqual(ref("big"))
        expect(prompts[1]!.variant).toBeUndefined()
        expect(plain.metadata).toMatchObject({ modelSource: "parent" })
        expect("effort" in plain.metadata).toBe(false)
      }),
    { trusted: true, config: priced },
  )

  tools.instance(
    "a batch takes model and effort in each entry, and refuses them beside the array before any child",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const asks: unknown[] = []
        const ctx = context({ sessionID: chat.id, messageID: assistant.id, ops: stubOps(prompts), asks })
        const brief = (n: number) => ({ description: `map part ${n}`, prompt: `Map part ${n}.` })

        const hybrid = yield* Effect.exit(def.execute({ tasks: [brief(1)], model: "lmstudio/mid" } as never, ctx))
        expect(Exit.isFailure(hybrid)).toBe(true)
        if (Exit.isFailure(hybrid))
          expect(Cause.pretty(hybrid.cause)).toContain("model goes inside each tasks entry, not beside the array.")
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
        expect(asks).toHaveLength(0)

        const result = yield* def.execute(
          { tasks: [{ ...brief(1), model: "mid", effort: "low" }, brief(2)], background: false },
          ctx,
        )
        expect(prompts.map((input) => [input.model?.modelID, input.variant])).toEqual(
          expect.arrayContaining([
            ["mid", "low"],
            ["big", undefined],
          ]),
        )
        const entries = (result.metadata as { tasks: Record<string, unknown>[] }).tasks
        expect(entries[0]).toMatchObject({ modelSource: "call", effort: "low" })
        expect(entries[1]).toMatchObject({ modelSource: "parent" })
      }),
    { trusted: true, config: priced },
  )
})

// The real prompt loop against a fake model server: what a Thorough parent passes to its general child.

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

const loop = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionStatus.node,
      Question.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      TaskLimits.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, noteQuietMs: 50, noteHoldMs: 300 })],
    ],
  ),
)

// A model that can reason or not: its efforts are "none" and "high".
const north = ref("north-mini-code")

function loopConfig(url: string): Partial<ConfigV1.Info> {
  return {
    formatter: false,
    lsp: false,
    provider: {
      lmstudio: {
        name: "Test",
        id: "lmstudio",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "north-mini-code": {
            id: "cohere/north-mini-code",
            name: "North Mini Code",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url, concurrency: 64 },
      },
    },
  }
}

const BRIEF = "PARSER_BRIEF: list the parser's entry points and report them"
const isChild = (hit: { body: Record<string, unknown> }) =>
  Array.isArray(hit.body.messages) &&
  hit.body.messages.some(
    (message) => isRecord(message) && message.role === "user" && JSON.stringify(message.content).includes(BRIEF),
  )
const isTitle = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

describe("Thorough passes effort down", () => {
  loop.instance(
    "a Thorough parent's general child runs at high effort through the sized path, its variant left unset",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "vector.json")
        yield* fs.writeWithDirs(file, JSON.stringify(loopConfig(llm.url)))
        const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
        yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const run = Effect.fn("test.run")(function* (text: string) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.pushMatch(
            (hit) => !isChild(hit) && !isTitle(hit.body),
            reply().tool("task", {
              description: "Map the parser",
              prompt: BRIEF,
              subagent_type: "general",
              background: false,
            }),
            reply().text("Mapped the parser.").stop(),
          )
          yield* llm.pushMatch(isChild, reply().text("Entry points: parse() and tokenize().").stop())
          const before = (yield* llm.hits).length
          const result = yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            model: north,
            parts: [{ type: "text", text }],
          })
          const hits = (yield* llm.hits).slice(before).filter((hit) => !isTitle(hit.body))
          const [child] = yield* sessions.children(chat.id)
          const opener = (yield* sessions.messages({ sessionID: child!.id })).find((item) => item.info.role === "user")
          return {
            size: result.info.role === "assistant" ? result.info.size : undefined,
            root: hits.filter((hit) => !isChild(hit)).map((hit) => hit.body.reasoning_effort),
            child: hits.filter(isChild).map((hit) => hit.body.reasoning_effort),
            record: SubagentLifecycle.read(child!),
            variant: opener?.info.role === "user" ? opener.info.model.variant : "missing",
          }
        })

        const thorough = yield* run("be thorough: map the parser's entry points across the codebase")
        expect(thorough.size).toBe("thorough")
        expect(thorough.root[0]).toBe("high")
        expect(thorough.child).toEqual(["high"])
        expect(thorough.variant).toBeUndefined()
        expect(thorough.record).toMatchObject({ effort: "high", modelSource: "parent" })
        expect(thorough.record?.model.variant).toBeUndefined()

        // Work passes nothing down: the child runs at the provider's own effort.
        const work = yield* run("map the parser's entry points")
        expect(work.size).toBe("standard")
        expect(work.child).toEqual([undefined])
        expect(work.record?.effort).toBeUndefined()
        expect(work.record?.modelSource).toBe("parent")
      }),
    { git: true },
    90_000,
  )

  // On a provider with cache breakpoints the parent keeps Thorough's high effort while that cache is warm, so a Work
  // follow-up still runs at high itself. Its children start caches of their own and get nothing passed down.
  loop.instance(
    "a Work follow-up within a Thorough request's cache lifetime passes no high effort down",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "vector.json")
        const config = loopConfig(llm.url)
        const lmstudio = config.provider!.lmstudio!
        lmstudio.models = {
          "claude-coder": { ...lmstudio.models!["north-mini-code"]!, id: "claude-coder", name: "Claude Coder" },
        }
        yield* fs.writeWithDirs(file, JSON.stringify(config))
        const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
        yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Sticky" })

        const run = Effect.fn("test.run")(function* (text: string) {
          yield* llm.pushMatch(
            (hit) => !isChild(hit) && !isTitle(hit.body),
            reply().tool("task", {
              description: "Map the parser",
              prompt: BRIEF,
              subagent_type: "general",
              background: false,
            }),
            reply().text("Mapped the parser.").stop(),
          )
          yield* llm.pushMatch(isChild, reply().text("Entry points: parse() and tokenize().").stop())
          const before = (yield* llm.hits).length
          const result = yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref("claude-coder"),
            parts: [{ type: "text", text }],
          })
          const hits = (yield* llm.hits).slice(before).filter((hit) => !isTitle(hit.body))
          const child = (yield* sessions.children(chat.id)).at(-1)
          return {
            size: result.info.role === "assistant" ? result.info.size : undefined,
            root: hits.filter((hit) => !isChild(hit)).map((hit) => hit.body.reasoning_effort),
            child: hits.filter(isChild).map((hit) => hit.body.reasoning_effort),
            record: SubagentLifecycle.read(child!),
          }
        })

        const thorough = yield* run("be thorough: map the parser's entry points across the codebase")
        expect(thorough.size).toBe("thorough")
        expect(thorough.root[0]).toBe("high")
        expect(thorough.record).toMatchObject({ effort: "high" })

        const work = yield* run("now map the printer's entry points")
        expect(work.size).toBe("standard")
        // The parent itself stays at high, so its cached messages hold.
        expect(work.root[0]).toBe("high")
        expect(work.child).toEqual([undefined])
        expect(work.record?.effort).toBeUndefined()
      }),
    { git: true },
    90_000,
  )
})
