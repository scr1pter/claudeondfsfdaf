import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
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
import { SessionFork } from "@/session/fork"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { LAUNCHING_REASON, TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { TaskNotify } from "@/task/notify"
import { TaskLimits } from "@/task/limits"
import { TaskManager } from "@/task/manager"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { SubagentModel } from "@/agent/subagent-model"
import { isRecord } from "@/util/record"
import { Brain } from "@vectordevai/core/brain/brain"
import { Instruction } from "../../src/session/instruction"
import { SessionMemory } from "../../src/session/memory"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

// Fork wiring (multi-agent contract 5.E.3, I3, I20): a fork's refusals, its launch after the response that launched it,
// the request shape every prompt into it keeps, its first own message written once, and the tools it may not run.

afterEach(async () => {
  await disposeAllInstances()
})

const lmstudio = ProviderV2.ID.make("lmstudio")
const ref = (modelID: string) => ({ providerID: lmstudio, modelID: ModelV2.ID.make(modelID) })

const nodes = [
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
] as const
const flags = RuntimeFlags.layer({ noteQuietMs: 50, noteHoldMs: 300 })

const tools = testEffect(LayerNode.compile(LayerNode.group([...nodes, SessionFork.node]), [[RuntimeFlags.node, flags]]))
// The task tool built on its own, without the prefixes the run loop keeps.
const alone = testEffect(LayerNode.compile(LayerNode.group([...nodes]), [[RuntimeFlags.node, flags]]))
// Background subagents turned off (VECTOR_DISABLE_BACKGROUND_SUBAGENTS).
const foreground = testEffect(
  LayerNode.compile(LayerNode.group([...nodes, SessionFork.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ noteQuietMs: 50, noteHoldMs: 300, backgroundSubagents: false })],
  ]),
)

const model = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  attachment: false,
  reasoning: true,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100_000, output: 10_000 },
  cost: { input: 0, output: 0 },
  variants: { low: {}, medium: {}, high: {} },
  ...over,
})

const config = (extra: Partial<ConfigV1.Info> = {}) => ({
  provider: {
    lmstudio: {
      name: "Test",
      id: "lmstudio",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
      models: {
        // A local model: $0, so it forks without a provider cache.
        free: model("free"),
        // A paid model whose provider caches nothing.
        paid: model("paid", { cost: { input: 1, output: 5 } }),
        nowindow: model("nowindow", { limit: { context: 0, output: 10_000 } }),
      },
    },
  },
  ...extra,
})

/** A conversation with one request and the step that calls task. */
const seed = Effect.fn("TaskForkTest.seed")(function* (
  input: {
    modelID?: string
    user?: Partial<SessionV1.User>
    launching?: Partial<SessionV1.Assistant>
    permission?: SessionV1.User["tools"] extends unknown ? Session.Info["permission"] : never
    parentID?: SessionID
    before?: Partial<SessionV1.Assistant>
    /** The request's text. */
    text?: string
    /** A compaction before the request, whose summary counted this many input tokens. */
    summary?: number
  } = {},
) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({
    title: "Parser",
    ...(input.parentID ? { parentID: input.parentID } : {}),
    permission: input.permission ?? [{ permission: "*", pattern: "*", action: "allow" }],
  })
  const modelRef = ref(input.modelID ?? "free")
  const assistantOf = (parentID: MessageID, over: Partial<SessionV1.Assistant> = {}): SessionV1.Assistant => ({
    id: MessageID.ascending(),
    role: "assistant",
    parentID,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: modelRef.modelID,
    providerID: lmstudio,
    time: { created: Date.now() },
    ...over,
  })
  if (input.before) {
    const earlier = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: modelRef,
      time: { created: Date.now() },
    })
    yield* sessions.updateMessage(assistantOf(earlier.id, input.before))
  }
  if (input.summary !== undefined) {
    const compaction = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: modelRef,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: compaction.id,
      sessionID: chat.id,
      type: "compaction",
      auto: true,
    })
    const summary = yield* sessions.updateMessage(
      assistantOf(compaction.id, {
        mode: "compaction",
        agent: "compaction",
        summary: true,
        finish: "stop",
        tokens: { input: input.summary, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    )
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: summary.id,
      sessionID: chat.id,
      type: "text",
      text: "The parser and printer were discussed at length.",
    })
  }
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: modelRef,
    time: { created: Date.now() },
    ...input.user,
  } as SessionV1.User)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: chat.id,
    type: "text",
    text: input.text ?? "Fix the parser and the printer.",
  })
  // Finished unless a test says otherwise, so the fork does not wait for it.
  const launching = yield* sessions.updateMessage(assistantOf(user.id, { finish: "tool-calls", ...input.launching }))
  return { chat, user, launching: launching as SessionV1.Assistant }
})

const text = (input: SessionPrompt.PromptInput) =>
  input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

/**
 * Ops that run each child prompt as the run loop would store it: the user message with its request shape, then a
 * finished reply. `gate` holds a child prompt until it returns. Notes to the parent are only recorded.
 */
function forkOps(
  parentID: SessionID,
  prompts: SessionPrompt.PromptInput[],
  sessions: Session.Interface,
  gate?: (input: SessionPrompt.PromptInput) => Effect.Effect<void>,
): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        prompts.push(input)
        const reply = (sessionID: SessionID, parentMessage: MessageID): SessionV1.Assistant => ({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: parentMessage,
          sessionID,
          mode: input.agent ?? "build",
          agent: input.agent ?? "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: input.model?.modelID ?? ref("free").modelID,
          providerID: input.model?.providerID ?? lmstudio,
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })
        if (input.sessionID === parentID)
          return { info: reply(parentID, input.messageID ?? MessageID.ascending()), parts: [] }
        if (gate) yield* gate(input)
        const user = yield* sessions.updateMessage({
          id: input.messageID ?? MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          agent: input.agent ?? "build",
          model: {
            providerID: input.model?.providerID ?? lmstudio,
            modelID: input.model?.modelID ?? ref("free").modelID,
            ...(input.variant ? { variant: input.variant } : {}),
          },
          ...(input.system !== undefined ? { system: input.system } : {}),
          ...(input.tools ? { tools: input.tools } : {}),
          ...(input.executionMode ? { executionMode: input.executionMode } : {}),
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: input.sessionID,
          type: "text",
          text: text(input),
        })
        const info = yield* sessions.updateMessage(reply(input.sessionID, user.id))
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: info.id,
          sessionID: input.sessionID,
          type: "text",
          // A fork asked for a schema answers with a ```json block (TaskStructured text mode).
          text: text(input).includes("JSON Schema") ? '```json\n{"routes":["/parse"]}\n```' : "Fork done.",
        })
        return { info, parts: [part] }
      }),
  }
}

function context(input: {
  sessionID: SessionID
  messageID: MessageID
  ops: TaskPromptOps
  asks: unknown[]
  agent?: string
}) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: "call_fork",
    agent: input.agent ?? "build",
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

const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")
const brief = { description: "Fix the parser", prompt: "FORK_BRIEF: fix the parser's error recovery.", fork: true }

const recordOf = Effect.fn("TaskForkTest.record")(function* (id: SessionID) {
  return SubagentLifecycle.read(yield* (yield* Session.Service).get(id))
})

const settled = (id: SessionID, status: string) =>
  pollWithTimeout(
    recordOf(id).pipe(Effect.map((record) => (record?.status === status ? record : undefined))),
    `the fork must end ${status}`,
  )

describe("fork refusals", () => {
  tools.instance(
    "each reason refuses before the ask and before any child",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const asks: unknown[] = []
        const refused = Effect.fn("refused")(function* (
          setup: Parameters<typeof seed>[0],
          params: Record<string, unknown>,
          reason: string,
          agent?: string,
        ) {
          const { chat, launching } = yield* seed(setup)
          const ctx = context({
            sessionID: chat.id,
            messageID: launching.id,
            ops: forkOps(chat.id, prompts, sessions),
            asks,
            agent,
          })
          const exit = yield* Effect.exit(def.execute({ ...brief, ...params } as never, ctx))
          expect(failure(exit), reason).toContain(reason)
          expect(yield* sessions.children(chat.id), reason).toHaveLength(0)
        })

        yield* refused({}, { background: false }, "A fork runs only in the background; leave background out.")
        yield* refused(
          {},
          { subagent_type: "explore" },
          "A fork runs as you, the build agent; leave subagent_type out.",
        )
        yield* refused({}, { model: "lmstudio/paid" }, SubagentModel.FORK)
        yield* refused({}, { effort: "low" }, SubagentModel.FORK)
        yield* refused(
          {},
          { context_pack: { findings: ["x"] } },
          "A fork already has your whole conversation; leave context_pack out.",
        )
        yield* refused(
          { modelID: "paid" },
          {},
          "Your provider does not cache prompts, so a fork would pay for your whole conversation again",
        )
        yield* refused({ modelID: "nowindow" }, {}, "Your model lists no context window")
        yield* refused(
          {
            user: {
              format: new SessionV1.OutputFormatJsonSchema({ type: "json_schema", schema: { type: "object" } }),
            },
          },
          {},
          "This step must answer in a JSON schema, so it cannot fork",
        )
        yield* refused({}, {}, "The research agent cannot fork", "research")
        yield* refused(
          {
            before: {
              finish: "stop",
              tokens: { input: 80_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
          {},
          "Your conversation (80000 tokens) is over half of what your model can take, too long to fork",
        )
        yield* refused(
          { permission: [{ permission: "task", pattern: "fork", action: "deny" }] },
          {},
          "The task permission denies forks to the build agent",
        )
        // A subagent's own session is never the main agent of a conversation.
        const { chat: root } = yield* seed()
        yield* refused({ parentID: root.id }, {}, "Only the main agent of a conversation can fork")
        // A batch takes fork in each entry, never beside the array.
        const { chat, launching } = yield* seed()
        const beside = yield* Effect.exit(
          def.execute(
            { tasks: [{ description: "a", prompt: "b" }], fork: true } as never,
            context({ sessionID: chat.id, messageID: launching.id, ops: forkOps(chat.id, prompts, sessions), asks }),
          ),
        )
        expect(failure(beside)).toContain("fork goes inside each tasks entry, not beside the array.")
        expect(asks).toHaveLength(0)
        expect(prompts).toHaveLength(0)
      }),
    { trusted: true, config: config() },
  )

  tools.instance(
    "forks turned off in sizing.subagents are refused",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, launching } = yield* seed()
        const asks: unknown[] = []
        const exit = yield* Effect.exit(
          def.execute(
            brief,
            context({ sessionID: chat.id, messageID: launching.id, ops: forkOps(chat.id, [], sessions), asks }),
          ),
        )
        expect(failure(exit)).toContain("Forks are turned off (sizing.subagents.fork); write a brief instead.")
        // A fork launched before forks were turned off does not resume either: it would send its whole window again.
        const fork = yield* sessions.create({
          parentID: chat.id,
          metadata: {
            subagent: {
              kind: "subagent",
              custom: false,
              agent: "build",
              title: "Fix the parser",
              parentSessionID: chat.id,
              parentMessageID: launching.id,
              model: ref("free"),
              status: "completed",
              startedAt: Date.now(),
              completedAt: Date.now(),
              attempt: 1,
              fork: { point: launching.id },
            },
          },
        })
        const resumed = yield* Effect.exit(
          def.execute(
            { description: "Fix the parser", prompt: "Carry on.", task_id: fork.id },
            context({ sessionID: chat.id, messageID: launching.id, ops: forkOps(chat.id, [], sessions), asks }),
          ),
        )
        expect(failure(resumed)).toContain(SessionFork.TURNED_OFF)
        expect(asks).toHaveLength(0)
      }),
    { trusted: true, config: config({ sizing: { subagents: { fork: false } } }) },
  )

  tools.instance(
    "the size check measures what a fork inherits: a large first message counts, a summary's count does not",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const asks: unknown[] = []
        const launch = (seeded: { chat: Session.Info; launching: SessionV1.Assistant }) =>
          def.execute(
            brief,
            context({
              sessionID: seeded.chat.id,
              messageID: seeded.launching.id,
              ops: forkOps(seeded.chat.id, prompts, sessions),
              asks,
            }),
          )
        // The conversation's first response forks after a message that alone fills more than half the window: no
        // step has finished yet, so only the message itself shows its size.
        const big = yield* seed({ text: "parser ".repeat(40_000) })
        const refused = yield* Effect.exit(launch(big))
        expect(failure(refused)).toMatch(
          /Your conversation \((\d+) tokens\) is over half of what your model can take, too long to fork/,
        )
        expect(Number(/\((\d+) tokens\)/.exec(failure(refused))?.[1])).toBeGreaterThan(65_000)
        expect(yield* sessions.children(big.chat.id)).toHaveLength(0)
        // A summary counted the history it replaced, so a short conversation after a compaction still forks.
        const compacted = yield* seed({ summary: 90_000 })
        const result = yield* launch(compacted)
        expect(result.output).toContain("Background task started")
        expect((result.metadata as { inheritedTokens: number }).inheritedTokens).toBeLessThan(1_000)
        const [child] = yield* sessions.children(compacted.chat.id)
        yield* settled(child!.id, "completed")
      }),
    { trusted: true, config: config() },
  )

  alone.instance(
    "without the run loop's prefixes a fork is refused",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, launching } = yield* seed()
        const exit = yield* Effect.exit(
          def.execute(
            brief,
            context({ sessionID: chat.id, messageID: launching.id, ops: forkOps(chat.id, [], sessions), asks: [] }),
          ),
        )
        expect(failure(exit)).toContain("Forks are not available in this engine; write a brief instead.")
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    { trusted: true, config: config() },
  )

  foreground.instance(
    "with background subagents turned off a fork is refused",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, launching } = yield* seed()
        const asks: unknown[] = []
        const exit = yield* Effect.exit(
          def.execute(
            brief,
            context({ sessionID: chat.id, messageID: launching.id, ops: forkOps(chat.id, [], sessions), asks }),
          ),
        )
        expect(failure(exit)).toContain(
          "A fork runs only in the background, and background subagents are turned off; write a brief instead.",
        )
        expect(asks).toHaveLength(0)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    { trusted: true, config: config() },
  )
})

describe("fork launch", () => {
  tools.instance(
    "with general disabled, a fork still launches as the agent that launched it",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, launching } = yield* seed()
        const prompts: SessionPrompt.PromptInput[] = []
        const asks: unknown[] = []
        const result = yield* def.execute(
          brief,
          context({ sessionID: chat.id, messageID: launching.id, ops: forkOps(chat.id, prompts, sessions), asks }),
        )
        expect(result.output).toContain("Background task started")
        expect(asks).toEqual([expect.objectContaining({ permission: "task", patterns: ["fork"] })])
        const [child] = yield* sessions.children(chat.id)
        expect(child!.title).toBe("Fix the parser (@fork subagent)")
        expect(child!.agent).toBe("build")
        // Its own rules refuse what a fork may never run, after the parent's.
        expect(child!.permission).toEqual(
          expect.arrayContaining(SessionFork.FORK_DENIES({}).map((rule) => expect.objectContaining(rule))),
        )
        yield* settled(child!.id, "completed")
        expect(text(prompts.find((input) => input.sessionID === child!.id)!)).toContain("<fork_assignment>")
      }),
    { trusted: true, config: config({ agent: { general: { disable: true } } }) },
  )

  tools.instance(
    "a fork waits for its launching response, then sends its assignment with the parent user's request shape",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const forks = yield* SessionFork.Service
        const provider = yield* Provider.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, user, launching } = yield* seed({
          user: { system: "PARENT_SYSTEM", tools: { webfetch: false }, executionMode: "normal" },
          launching: { finish: undefined, variant: "low" },
        })
        // The run loop keeps the step's prefix before it is sent; the processor ends the step.
        const free = yield* provider.getModel(lmstudio, ref("free").modelID)
        yield* forks.remember({
          messageID: launching.id,
          sessionID: chat.id,
          request: {
            user: { ...user, model: { ...user.model, variant: "low" } } as SessionV1.User,
            agent: { name: "build", mode: "primary", options: {}, permission: [] },
            model: free,
            system: [],
            tools: {},
          },
          personal: true,
          audience: "owner",
        })
        // The variant the parent's step ran with.
        yield* sessions.updateMessage({ ...user, model: { ...user.model, variant: "low" } } as SessionV1.User)
        const prompts: SessionPrompt.PromptInput[] = []
        const result = yield* def.execute(
          brief,
          context({ sessionID: chat.id, messageID: launching.id, ops: forkOps(chat.id, prompts, sessions), asks: [] }),
        )
        // What it inherits is the parent's history before the launching step: here one short request (5.E.3).
        expect(result.metadata).toMatchObject({ fork: true, modelSource: "fork" })
        const inherited = (result.metadata as { inheritedTokens: number }).inheritedTokens
        expect(inherited).toBeGreaterThan(0)
        expect(inherited).toBeLessThan(200)
        const [child] = yield* sessions.children(chat.id)
        expect(yield* recordOf(child!.id)).toMatchObject({
          status: "queued",
          slotReason: LAUNCHING_REASON,
          modelSource: "fork",
          fork: { point: launching.id, callID: "call_fork" },
        })
        yield* Effect.sleep("100 millis")
        expect(prompts.filter((input) => input.sessionID === child!.id)).toHaveLength(0)

        yield* forks.stepFinished(launching.id, "tool-calls")
        const sent = yield* pollWithTimeout(
          Effect.sync(() => prompts.find((input) => input.sessionID === child!.id)),
          "the fork must be prompted once its launching step finished",
        )
        expect(sent).toMatchObject({
          agent: "build",
          model: ref("free"),
          variant: "low",
          system: "PARENT_SYSTEM",
          tools: { webfetch: false },
          executionMode: "normal",
        })
        expect(text(sent)).toContain("<fork_assignment>")
        expect(text(sent)).toContain("FORK_BRIEF")
        const record = yield* settled(child!.id, "completed")
        expect(record.fork).toEqual({ point: launching.id, callID: "call_fork", from: sent.messageID })
      }),
    { trusted: true, config: config() },
  )

  tools.instance(
    "a fork whose launching response failed is cancelled quietly, with no turn for the parent",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, launching } = yield* seed({
          launching: {
            finish: undefined,
            time: { created: Date.now(), completed: Date.now() },
            error: new SessionV1.APIError({ message: "boom", isRetryable: false }).toObject(),
          },
        })
        const prompts: SessionPrompt.PromptInput[] = []
        yield* def.execute(
          brief,
          context({ sessionID: chat.id, messageID: launching.id, ops: forkOps(chat.id, prompts, sessions), asks: [] }),
        )
        const [child] = yield* sessions.children(chat.id)
        yield* settled(child!.id, "cancelled")
        yield* Effect.sleep("500 millis")
        expect(prompts.filter((input) => input.sessionID === child!.id)).toHaveLength(0)
        // A note may record the cancellation, but none starts a parent turn.
        for (const input of prompts.filter((item) => item.sessionID === chat.id)) expect(input.noReply).toBe(true)
      }),
    { trusted: true, config: config() },
  )

  tools.instance(
    "a fork stopped before its launching response finished gets its assignment as its first message when resumed",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const manager = yield* TaskManager.Service
        const def = yield* (yield* TaskTool).init()
        // The launching step is still running, so the fork waits for it.
        const { chat, launching } = yield* seed({ launching: { finish: undefined } })
        const prompts: SessionPrompt.PromptInput[] = []
        const ops = forkOps(chat.id, prompts, sessions)
        const ctx = context({ sessionID: chat.id, messageID: launching.id, ops, asks: [] })
        yield* def.execute(brief, ctx)
        const [child] = yield* sessions.children(chat.id)
        // Stopped by the agent, which may resume it without a new word from the user (I6).
        yield* manager.stop({ sessionID: chat.id, taskIDs: [child!.id], origin: "agent" }, ops)
        yield* settled(child!.id, "cancelled")
        expect(prompts.filter((input) => input.sessionID === child!.id)).toHaveLength(0)

        yield* def.execute({ description: "Fix the parser", prompt: "AGAIN_BRIEF", task_id: child!.id }, ctx)
        const sent = yield* pollWithTimeout(
          Effect.sync(() => prompts.find((input) => input.sessionID === child!.id)),
          "the resumed fork must be prompted",
        )
        expect(text(sent)).toContain("<fork_assignment>")
        expect(text(sent)).toContain("AGAIN_BRIEF")
        const record = yield* pollWithTimeout(
          recordOf(child!.id).pipe(
            Effect.map((item) => (item?.status === "completed" && item.attempt === 2 ? item : undefined)),
          ),
          "the resumed fork must finish",
        )
        expect(record.fork?.from).toBe(sent.messageID)
      }),
    { trusted: true, config: config() },
  )

  tools.instance(
    "a fork resumed twice keeps its first own message and sends plain follow-ups in its request shape",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, launching } = yield* seed({ user: { system: "PARENT_SYSTEM", tools: { webfetch: false } } })
        const prompts: SessionPrompt.PromptInput[] = []
        const ctx = context({
          sessionID: chat.id,
          messageID: launching.id,
          ops: forkOps(chat.id, prompts, sessions),
          asks: [],
        })
        yield* def.execute(brief, ctx)
        const [child] = yield* sessions.children(chat.id)
        const first = yield* settled(child!.id, "completed")
        const from = first.fork!.from
        expect(from).toBeDefined()

        for (const [index, params] of [
          { description: "Fix the parser", prompt: "MORE_ONE", task_id: child!.id },
          { description: "Fix the parser", prompt: "MORE_TWO", task_id: child!.id, fork: true },
        ].entries()) {
          yield* def.execute(params, ctx)
          yield* pollWithTimeout(
            recordOf(child!.id).pipe(
              Effect.map((record) =>
                record?.status === "completed" && record.attempt === index + 2 ? record : undefined,
              ),
            ),
            "the resumed fork must finish",
          )
          const sent = prompts.filter((input) => input.sessionID === child!.id).at(-1)!
          expect(text(sent)).toContain(params.prompt)
          expect(text(sent)).not.toContain("<fork_assignment>")
          expect(sent).toMatchObject({ system: "PARENT_SYSTEM", tools: { webfetch: false }, model: ref("free") })
          expect((yield* recordOf(child!.id))!.fork!.from).toBe(from)
        }
      }),
    { trusted: true, config: config() },
  )

  tools.instance(
    "task_manage message and resume keep the fork's model, system and tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const manager = yield* TaskManager.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, launching } = yield* seed({ user: { system: "PARENT_SYSTEM", tools: { webfetch: false } } })
        const prompts: SessionPrompt.PromptInput[] = []
        const hold = yield* Deferred.make<void>()
        let held = false
        const ops = forkOps(chat.id, prompts, sessions, () =>
          held ? Effect.void : Effect.sync(() => void (held = true)).pipe(Effect.andThen(Deferred.await(hold))),
        )
        yield* def.execute(brief, context({ sessionID: chat.id, messageID: launching.id, ops, asks: [] }))
        const [child] = yield* sessions.children(chat.id)
        yield* pollWithTimeout(
          Effect.sync(() => (held ? true : undefined)),
          "the fork's first run must start",
        )
        yield* manager.message(
          { sessionID: chat.id, taskID: child!.id, text: "STEER_TEXT", delivery: "queue", origin: "agent" },
          ops,
        )
        yield* Deferred.succeed(hold, undefined)
        const steered = yield* pollWithTimeout(
          Effect.sync(() =>
            prompts.find((input) => input.sessionID === child!.id && text(input).includes("STEER_TEXT")),
          ),
          "the message must reach the fork",
        )
        expect(steered).toMatchObject({ system: "PARENT_SYSTEM", tools: { webfetch: false }, model: ref("free") })
        yield* settled(child!.id, "completed")

        yield* manager.resume(
          { sessionID: chat.id, taskIDs: [child!.id], text: "RESUME_TEXT", origin: "user", guest: false },
          ops,
        )
        const resumed = yield* pollWithTimeout(
          Effect.sync(() =>
            prompts.find((input) => input.sessionID === child!.id && text(input).includes("RESUME_TEXT")),
          ),
          "the resume must reach the fork",
        )
        expect(resumed).toMatchObject({ system: "PARENT_SYSTEM", tools: { webfetch: false }, model: ref("free") })
        expect(text(resumed)).not.toContain("<fork_assignment>")
      }),
    { trusted: true, config: config() },
  )

  tools.instance(
    "a fork with output_schema gets the schema in its assignment and in every later prompt, and answers in JSON",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, launching } = yield* seed()
        const prompts: SessionPrompt.PromptInput[] = []
        const ctx = context({
          sessionID: chat.id,
          messageID: launching.id,
          ops: forkOps(chat.id, prompts, sessions),
          asks: [],
        })
        const schema = {
          type: "object",
          properties: { routes: { type: "array", items: { type: "string" } } },
          required: ["routes"],
        }
        yield* def.execute({ ...brief, output_schema: schema }, ctx)
        const [child] = yield* sessions.children(chat.id)
        const record = yield* settled(child!.id, "completed")
        expect(record.structured).toMatchObject({ valid: true, attempts: 1 })
        const first = prompts.find((input) => input.sessionID === child!.id)!
        expect(first.format).toBeUndefined()
        expect(text(first)).toContain("<fork_assignment>")
        expect(text(first)).toContain(SessionFork.answerIn(record.structured!.schema))
        const note = yield* pollWithTimeout(
          Effect.sync(() =>
            prompts
              .filter((input) => input.sessionID === chat.id)
              .map(text)
              .find((value) => value.includes("<task-notification")),
          ),
          "the parent must get the fork's note",
        )
        expect(note).toContain('<task_result format="json">')
        expect(note).toContain('{"routes":["/parse"]}')

        yield* def.execute({ description: "Fix the parser", prompt: "MORE_ROUTES", task_id: child!.id }, ctx)
        yield* pollWithTimeout(
          recordOf(child!.id).pipe(
            Effect.map((item) => (item?.status === "completed" && item.attempt === 2 ? item : undefined)),
          ),
          "the resumed fork must finish",
        )
        const later = prompts.filter((input) => input.sessionID === child!.id).at(-1)!
        expect(text(later)).not.toContain("<fork_assignment>")
        expect(text(later)).toContain(SessionFork.answerIn(record.structured!.schema))
        expect((yield* recordOf(child!.id))!.structured).toMatchObject({ valid: true, attempts: 1 })
      }),
    { trusted: true, config: config() },
  )

  tools.instance(
    "Session.fork of a fork child does not inherit",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const forks = yield* SessionFork.Service
        const def = yield* (yield* TaskTool).init()
        const { chat, launching } = yield* seed()
        yield* def.execute(
          brief,
          context({ sessionID: chat.id, messageID: launching.id, ops: forkOps(chat.id, [], sessions), asks: [] }),
        )
        const [child] = yield* sessions.children(chat.id)
        yield* settled(child!.id, "completed")
        const copy = yield* sessions.fork({ sessionID: child!.id })
        const record = SubagentLifecycle.read(copy)!
        expect(record.fork).toBeUndefined()
        expect(copy.parentID).toBeUndefined()
        const inherited = yield* forks.inherited({
          session: copy,
          record,
          messages: yield* sessions.messages({ sessionID: copy.id }),
          model: ref("free"),
          agent: "build",
          personal: true,
          audience: "owner",
          guest: false,
        })
        expect(inherited).toBeUndefined()
      }),
    { trusted: true, config: config() },
  )
})

// The real run loop against a fake model server: a fork that calls tools it may not run.

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
      Brain.node,
      Instruction.node,
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

const ASSIGNMENT = "FORK_ONLY: fix the parser's error recovery"
const isFork = (hit: { body: Record<string, unknown> }) => JSON.stringify(hit.body).includes("<fork_assignment>")
const isTitle = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

describe("a fork in the run loop", () => {
  loop.instance(
    "refused tools return the refusal, and nothing is written to the parent's messages",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "vector.json")
        yield* fs.writeWithDirs(
          file,
          JSON.stringify({
            formatter: false,
            lsp: false,
            provider: {
              lmstudio: {
                name: "Test",
                id: "lmstudio",
                env: [],
                npm: "@ai-sdk/openai-compatible",
                models: { coder: model("coder", { reasoning: false, variants: undefined }) },
                options: { apiKey: "test-key", baseURL: llm.url, concurrency: 64 },
              },
            },
          }),
        )
        const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
        yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Forks",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.pushMatch(
          (hit) => !isFork(hit) && !isTitle(hit.body),
          reply().tool("task", { description: "Fix the parser", prompt: ASSIGNMENT, fork: true }),
          reply().text("Launched a fork.").stop(),
        )
        yield* llm.pushMatch(
          isFork,
          reply().tool("task", { description: "Nested", prompt: "Launch another." }),
          reply().tool("escalate", { reason: "The parser is hard." }),
          reply().text("Fixed the parser.").stop(),
        )
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref("coder"),
          size: "standard",
          parts: [{ type: "text", text: "Fix the parser and the printer." }],
        })
        const opener = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.role === "user")!
        const [child] = yield* sessions.children(chat.id)
        expect(SubagentLifecycle.read(child!)?.fork?.point).toBeDefined()
        yield* pollWithTimeout(
          recordOf(child!.id).pipe(Effect.map((record) => (record?.status === "completed" ? record : undefined))),
          "the fork must finish",
          "20 seconds",
        )
        const parts = (yield* sessions.messages({ sessionID: child!.id })).flatMap((item) => item.parts)
        const refusals = parts.flatMap((part) =>
          part.type === "tool" && part.state.status === "error" ? [[part.tool, part.state.error] as const] : [],
        )
        expect(refusals).toEqual([
          ["task", expect.stringContaining(SessionFork.refusal("task"))],
          ["escalate", expect.stringContaining(SessionFork.refusal("escalate"))],
        ])
        // The fork's first request carried the parent's history and its assignment; nothing was added to the parent.
        const forkHits = (yield* llm.hits).filter(isFork)
        expect(JSON.stringify(forkHits[0]!.body)).toContain("Fix the parser and the printer.")
        const after = (yield* sessions.messages({ sessionID: chat.id })).find(
          (item) => item.info.id === opener.info.id,
        )!
        expect(after.parts.map((part) => part.id)).toEqual(opener.parts.map((part) => part.id))
        expect(
          (yield* sessions.messages({ sessionID: child!.id })).filter((item) => item.info.role === "user").length,
        ).toBe(1)
        expect(isRecord(forkHits[0]!.body)).toBe(true)
        // briefFor never wrote into the parent: the turn that reads the fork's note, sent after the fork ran, carries the
        // parent's opening message exactly as its first request did.
        const parentHits = llm.hits.pipe(Effect.map((hits) => hits.filter((hit) => !isFork(hit) && !isTitle(hit.body))))
        const noted = yield* pollWithTimeout(
          parentHits.pipe(
            Effect.map((hits) => hits.find((hit) => JSON.stringify(hit.body.messages).includes("<task-notification "))),
          ),
          "the parent must read the fork's note",
          "20 seconds",
        )
        const opening = (hit: { body: Record<string, unknown> }) =>
          JSON.stringify((hit.body.messages as { role: string }[]).find((message) => message.role === "user"))
        expect(opening(noted)).toBe(opening((yield* parentHits)[0]!))
      }),
    { git: true },
    90_000,
  )

  // What a subagent's first step writes, how the owner works, goes on its first user message. A fork's first user
  // message is its parent's opener, which nothing has recalled for when the conversation opened with a chat reply.
  loop.instance(
    "briefFor never writes how the owner works into the parent's opening message",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "vector.json")
        yield* fs.writeWithDirs(
          file,
          JSON.stringify({
            formatter: false,
            lsp: false,
            provider: {
              lmstudio: {
                name: "Test",
                id: "lmstudio",
                env: [],
                npm: "@ai-sdk/openai-compatible",
                models: { coder: model("coder", { reasoning: false, variants: undefined }) },
                options: { apiKey: "test-key", baseURL: llm.url, concurrency: 64 },
              },
            },
          }),
        )
        const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
        yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
        const brain = yield* Brain.Service
        const place = yield* (yield* Instruction.Service).place()
        yield* brain.propose(place, {
          kind: "preference",
          text: "Run the parser tests with bun test before every commit",
          scope: "personal",
          origin: "user",
          evidence: { type: "user" },
        })
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Forks",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.pushMatch(
          (hit) => !isFork(hit) && !isTitle(hit.body),
          reply().text("They run with bun test.").stop(),
          reply().tool("task", { description: "Fix the parser", prompt: ASSIGNMENT, fork: true }),
          reply().text("Launched a fork.").stop(),
        )
        yield* llm.pushMatch(isFork, reply().text("Fixed the parser.").stop())
        // A chat reply opens the conversation, so no recall ran on its message.
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref("coder"),
          size: "chat",
          parts: [{ type: "text", text: "How do the parser tests run?" }],
        })
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref("coder"),
          size: "standard",
          parts: [{ type: "text", text: "Fix the parser and the printer." }],
        })
        const [child] = yield* sessions.children(chat.id)
        expect(SubagentLifecycle.read(child!)?.fork?.point).toBeDefined()
        yield* pollWithTimeout(
          recordOf(child!.id).pipe(Effect.map((record) => (record?.status === "completed" ? record : undefined))),
          "the fork must finish",
          "20 seconds",
        )
        const opener = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.role === "user")!
        expect(opener.parts.map((part) => part.type === "text" && part.text)).toContain("How do the parser tests run?")
        expect(opener.parts.every((part) => part.sessionID === chat.id)).toBe(true)
        expect(opener.parts.some((part) => part.type === "text" && part.metadata?.[SessionMemory.RECALL])).toBe(false)
      }),
    { git: true },
    90_000,
  )
})
