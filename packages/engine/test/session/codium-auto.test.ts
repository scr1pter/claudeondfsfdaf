// Codium Auto in an engine session (A19): the session keeps Auto, and each user message runs on the one model Auto
// picks for it. Every service is in-process: the Codium catalog is a fixed answer and the chat transport a function, so
// no network, gateway process or nested Bun process is involved. The shell case runs `echo` through /bin/sh.
import { afterEach, expect, test } from "bun:test"
import { Effect, Exit, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { LLMEvent } from "@vectordevai/llm"
import { Brain } from "@vectordevai/core/brain/brain"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { SessionTable } from "@vectordevai/core/session/sql"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Database } from "@vectordevai/core/database/database"
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
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionCodiumAuto } from "../../src/session/codium-auto"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"
import { testEffect } from "../lib/effect"
import { textStream, toolCallStream } from "../../../core/test/fixture/codium-gateway"

const token = "vct_synthetic-private-account.token"
// Each role has its own window, so a step up shows in the model a request names.
const floor = { id: "vendor/floor", name: "Floor", contextLength: 16_000, maxOutputTokens: 2_000 }
const middle = { id: "vendor/default", name: "Default", contextLength: 64_000, maxOutputTokens: 4_096 }
const ceiling = { id: "vendor/ceiling", name: "Ceiling", contextLength: 200_000, maxOutputTokens: 8_192 }
const withAuto: ModelPlans.Catalog = {
  enabled: true,
  plan: "vector-50",
  models: [
    { ...middle, lab: "deepseek", role: "default" },
    {
      id: ModelPlanStatus.AUTO_ID,
      name: "Codium Auto",
      contextLength: middle.contextLength,
      maxOutputTokens: middle.maxOutputTokens,
      auto: { floor: floor.id, default: middle.id, ceiling: ceiling.id },
    },
    { ...floor, lab: "openai", role: "floor" },
    { ...ceiling, lab: "openai", role: "ceiling" },
  ],
}
// An older gateway's answer: the same models, no Auto.
const withoutAuto: ModelPlans.Catalog = { enabled: true, models: [middle, floor, ceiling] }

const state = {
  catalog: withAuto,
  // What each chat request after the queue runs out answers: a plain reply.
  replies: [] as "tool"[],
  sent: [] as { purpose: string | null; model: unknown }[],
}
afterEach(() => {
  state.catalog = withAuto
  state.replies = []
  state.sent = []
  answered.length = 0
})

const sse = (chunks: readonly unknown[]) =>
  new Response([...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""), {
    headers: { "content-type": "text/event-stream" },
  })

const auto = { providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID), modelID: ModelV2.ID.make(ModelPlans.AUTO_ID) }
const autoRef = { providerID: ModelPlans.PROVIDER_ID, modelID: ModelPlans.AUTO_ID }

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
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
  Brain.node,
])

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

const codium = Layer.succeed(ModelPlans.Service, {
  catalog: (account) => Effect.sync(() => (account === token ? state.catalog : { enabled: false, models: [] })),
  request: async (_url, init) => {
    const body = JSON.parse(String(init.body))
    state.sent.push({ purpose: new Headers(init.headers).get("x-vector-purpose"), model: body.model })
    if (body.model === ModelPlans.AUTO_ID) throw new Error("Codium Auto was sent to the gateway")
    return sse(state.replies.shift() === "tool" ? toolCallStream : textStream)
  },
})

const replacements = [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  [
    FreeModels.credentialsNode,
    Layer.succeed(FreeModels.CredentialsService, {
      get: (provider) => Effect.succeed(provider === "vector" ? token : undefined),
    }),
  ],
  [ModelPlans.node, codium],
] as const

const it = testEffect(
  LayerNode.compile(root, [
    ...replacements,
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([]),
        trainingConsent: () => Effect.succeed(false),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
    ],
  ]),
)

// The same stack with Vector's shared free models listed, where each model call is answered here and kept with the model
// it ran on, instead of sent anywhere: a free model's requests would otherwise leave for vectordev.ai.
const freeModel = FREE_MODEL_FALLBACKS[0]!
const freeRef = { providerID: ProviderV2.ID.make("vector"), modelID: ModelV2.ID.make(freeModel.id) }
const answered: { agent: string; providerID: string; modelID: string }[] = []
const free = testEffect(
  LayerNode.compile(root, [
    ...replacements,
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: true, updatedAt: 1, models: [...FREE_MODEL_FALLBACKS] }),
        forKey: () => Effect.succeed([]),
        trainingConsent: () => Effect.succeed(false),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
    ],
    [
      LLM.node,
      Layer.succeed(LLM.Service, {
        stream: (input) => {
          answered.push({ agent: input.agent.name, providerID: input.model.providerID, modelID: input.model.id })
          // As LLM.stream does at the response's first event; a session's title waits for it.
          input.answering?.()
          return Stream.make(
            LLMEvent.textStart({ id: "reply" }),
            LLMEvent.textDelta({ id: "reply", text: "Done." }),
            LLMEvent.textEnd({ id: "reply" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          )
        },
      }),
    ],
  ]),
)

const chat = () => state.sent.filter((item) => item.purpose === "chat")

const users = Effect.fn("test.users")(function* (sessionID: Session.Info["id"]) {
  const sessions = yield* Session.Service
  return (yield* sessions.messages({ sessionID })).flatMap((message) =>
    message.info.role === "user" ? [message.info] : [],
  )
})

it.instance("each message runs on the model Auto picks for its size; the session and the choice stay on Auto", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: auto,
      size: "thorough",
      parts: [{ type: "text", text: "Rework the cache layer" }],
    })
    // No model named: the session's choice, Auto, picks again, this time for standard work.
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      size: "standard",
      parts: [{ type: "text", text: "Now update the docs" }],
    })
    const [first, second] = yield* users(session.id)
    expect(first).toMatchObject({ model: { modelID: ceiling.id }, selected: autoRef })
    expect(second).toMatchObject({ model: { modelID: middle.id }, selected: autoRef })
    expect((yield* sessions.get(session.id)).model).toMatchObject({ id: ModelPlans.AUTO_ID })
    expect(chat().map((item) => item.model)).toEqual([ceiling.id, middle.id])
  }),
)

it.instance("a message too large for its role's window moves up to a role whose window holds it", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Pinned" })
    // About 15,000 tokens: over 80% of the floor's 16,000-token window, well inside the default's.
    const pasted = "x".repeat(60_000)
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: auto,
      size: "chat",
      parts: [{ type: "text", text: `What does this log say?\n${pasted}` }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: auto,
      size: "chat",
      parts: [{ type: "text", text: "Thanks" }],
    })
    const [large, small] = yield* users(session.id)
    expect(String(large?.model.modelID)).toBe(middle.id)
    // The pasted log is still in the history the next message is sent with.
    expect(String(small?.model.modelID)).toBe(middle.id)
    const visible = MessageV2.filterCompacted((yield* sessions.messages({ sessionID: session.id })).toReversed())
    expect(SessionCodiumAuto.contextTokens(visible)).toBeGreaterThan(floor.contextLength * 0.8)
  }),
)

it.instance("every step of a message keeps the one model Auto picked for it", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    state.replies = ["tool"]
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: auto,
      size: "standard",
      parts: [{ type: "text", text: "Read src/a.ts and explain it" }],
    })
    expect(chat().map((item) => item.model)).toEqual([middle.id, middle.id])
    const assistants = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) =>
      message.info.role === "assistant" ? [message.info.modelID] : [],
    )
    expect(assistants.map(String)).toEqual([middle.id, middle.id])
  }),
)

it.instance("/compact on a session that is on Auto summarises on a model Auto picks, never on Auto itself", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const compaction = yield* SessionCompaction.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: auto,
      size: "standard",
      parts: [{ type: "text", text: "Explain the cache layer" }],
    })
    yield* compaction.create({ sessionID: session.id, agent: "build", model: auto, auto: false })
    yield* prompt.loop({ sessionID: session.id })
    const marker = (yield* sessions.messages({ sessionID: session.id })).find((message) =>
      message.parts.some((part) => part.type === "compaction"),
    )
    expect(marker?.info).toMatchObject({ model: { modelID: middle.id }, selected: autoRef })
    expect(state.sent.length).toBeGreaterThan(1)
    expect(state.sent.every((item) => item.model !== ModelPlans.AUTO_ID)).toBe(true)
  }),
)

it.instance(
  "a session on Auto that compacts by itself stays on Auto: the marker and the continue message keep the choice",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // The first step (a tool call, 1,050 tokens) passes the ceiling model's 600-token window, so the run compacts
      // before its next step; the summary and the reply after it (206 tokens each) fit.
      state.replies = ["tool"]
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: auto,
        size: "thorough",
        parts: [{ type: "text", text: "Rework the cache layer" }],
      })
      const messages = yield* sessions.messages({ sessionID: session.id })
      const marker = messages.find((message) => message.parts.some((part) => part.type === "compaction"))
      expect(marker?.info).toMatchObject({ model: { modelID: ceiling.id }, selected: autoRef })
      const resumed = messages.find((message) =>
        message.parts.some((part) => part.type === "text" && part.metadata?.compaction_continue === true),
      )
      expect(resumed?.info).toMatchObject({ model: { modelID: ceiling.id }, selected: autoRef })
      // What the app and the TUI restore, and what the next message without a model runs on: Auto, picking again.
      const last = (yield* users(session.id)).at(-1)
      expect(last && ModelPlanStatus.sessionModel(last)).toEqual(autoRef)
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        size: "thorough",
        parts: [{ type: "text", text: "Now the tests" }],
      })
      expect((yield* users(session.id)).at(-1)).toMatchObject({ model: { modelID: ceiling.id }, selected: autoRef })
      expect(state.sent.every((item) => item.model !== ModelPlans.AUTO_ID)).toBe(true)
    }),
  { config: { compaction: { reserved: 199_400 } } },
)

it.instance(
  "a shell command on a session that is on Auto records a model Auto picked",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: auto,
        noReply: true,
        parts: [{ type: "text", text: "Start" }],
      })
      yield* prompt.shell({ sessionID: session.id, agent: "build", command: "echo hi" })
      const shell = (yield* users(session.id)).at(-1)
      expect(shell).toMatchObject({ model: { modelID: middle.id }, selected: autoRef })
      expect(state.sent).toEqual([])
    }),
  { config: { shell: "/bin/sh" } },
)

it.instance("a plan without a usable Auto fails the message with a Codium notice and sends nothing", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const session = yield* sessions.create({ title: "Pinned" })
    const errors: unknown[] = []
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === session.id) errors.push(data.error)
      return Effect.void
    })
    state.catalog = withoutAuto
    const result = yield* prompt
      .prompt({ sessionID: session.id, agent: "build", model: auto, parts: [{ type: "text", text: "Fix it" }] })
      .pipe(Effect.exit)
    yield* off
    expect(Exit.isFailure(result)).toBe(true)
    expect(state.sent).toEqual([])
    expect(errors.map((error) => ModelPlanStatus.failureAction(error))).toEqual(["unavailable"])
    expect(JSON.stringify(errors[0])).toContain("Codium Auto is not available")
    // Nothing was saved for the refused message; the session keeps Auto for when the plan offers it again.
    expect(yield* users(session.id)).toEqual([])
    expect((yield* sessions.get(session.id)).model).toMatchObject({ id: ModelPlans.AUTO_ID })
  }),
)

it.instance("a subtask on Auto runs its subagent on a model Auto picked", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: auto,
      noReply: true,
      parts: [
        {
          type: "subtask",
          prompt: "look into the cache key path",
          description: "inspect bug",
          agent: "general",
          model: auto,
        },
      ],
    })
    yield* prompt.loop({ sessionID: session.id })
    const [child] = yield* sessions.children(session.id)
    if (!child) throw new Error("Expected the subagent's session")
    const steps = (yield* sessions.messages({ sessionID: child.id })).flatMap((message) =>
      message.info.role === "assistant" ? [message.info.modelID] : [],
    )
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.every((id) => id === middle.id)).toBe(true)
    expect(state.sent.every((item) => item.model !== ModelPlans.AUTO_ID)).toBe(true)
  }),
)

// What Session.Event.Error reported for one session while `run` ran, and how `run` ended.
const errorsDuring = Effect.fn("test.errorsDuring")(function* <A, E, R>(
  sessionID: Session.Info["id"],
  run: Effect.Effect<A, E, R>,
) {
  const events = yield* EventV2Bridge.Service
  const errors: unknown[] = []
  const off = yield* events.listen((event) => {
    if (event.type !== Session.Event.Error.type) return Effect.void
    const data = event.data as typeof Session.Event.Error.data.Type
    if (data.sessionID === sessionID) errors.push(data.error)
    return Effect.void
  })
  const result = yield* run.pipe(Effect.exit)
  yield* off
  return { result, errors }
})

it.instance("a Codium conversation without a helper model gets no title and no model learning on its own model", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const brain = yield* Brain.Service
    // The model learner runs with any model here; by default it runs only with Vector Local on, where Codium is off.
    yield* brain.setLearnSettings({ learning: true, modelLearner: "always" })
    const purposes = Effect.fn("test.purposes")(function* () {
      const session = yield* sessions.create({})
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: auto.providerID, modelID: ModelV2.ID.make(middle.id) },
        size: "standard",
        // A correction the rules find nothing in, which the model learner reads.
        parts: [{ type: "text", text: "no, I meant use pnpm for the workspace" }],
      })
      yield* prompt.awaitTitles()
      const sent = state.sent.map((item) => item.purpose)
      state.sent = []
      return sent.toSorted()
    })
    // With Auto's floor to run on, the title and the learner each send a request of their own.
    expect(yield* purposes()).toEqual(["brain", "chat", "title"])
    // An older gateway's catalog has no Auto, so there is no helper model: only the message's own request goes.
    state.catalog = withoutAuto
    expect(yield* purposes()).toEqual(["chat"])
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const brain = yield* Brain.Service
        yield* brain.setLearnSettings({ modelLearner: "local-only" })
      }),
    ),
  ),
)

it.instance("a session whose row names no model picks Auto again from the last message's choice", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const session = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: auto,
      size: "thorough",
      parts: [{ type: "text", text: "Rework the cache layer" }],
    })
    // As in a session from before sessions kept their model: only its messages say what was chosen.
    yield* database.db
      .update(SessionTable)
      .set({ model: null })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      size: "standard",
      parts: [{ type: "text", text: "Now update the docs" }],
    })
    const [first, second] = yield* users(session.id)
    expect(first).toMatchObject({ model: { modelID: ceiling.id }, selected: autoRef })
    // Auto, not the ceiling model it picked for the first message.
    expect(second).toMatchObject({ model: { modelID: middle.id }, selected: autoRef })
  }),
)

it.instance(
  "a shell command on Auto runs when Auto cannot pick a model now, and its message keeps Auto as the choice",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: auto,
        noReply: true,
        parts: [{ type: "text", text: "Start" }],
      })
      // The plan stops offering Auto: the next model turn says so, but a local command needs no model.
      state.catalog = withoutAuto
      const { result, errors } = yield* errorsDuring(
        session.id,
        prompt.shell({ sessionID: session.id, agent: "build", command: "echo hi" }),
      )
      expect(Exit.isSuccess(result)).toBe(true)
      expect(errors).toEqual([])
      const part = Exit.isSuccess(result) ? result.value.parts[0] : undefined
      expect(part?.type === "tool" && part.state.status === "completed" ? part.state.output : "").toContain("hi")
      const shell = (yield* users(session.id)).at(-1)
      expect(shell?.model).toMatchObject({ modelID: ModelPlans.AUTO_ID })
      expect(shell).not.toHaveProperty("selected")
      expect(state.sent).toEqual([])
    }),
  { config: { shell: "/bin/sh" } },
)

it.instance(
  "the turn after a shell message that kept Auto picks once, stores the pick beside Auto and stays on it",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: auto,
        noReply: true,
        parts: [{ type: "text", text: "Start" }],
      })
      // Auto could not pick when the command ran, so its message kept Auto.
      state.catalog = withoutAuto
      yield* prompt.shell({ sessionID: session.id, agent: "build", command: "echo hi" })
      expect((yield* users(session.id)).at(-1)?.model).toMatchObject({ modelID: ModelPlans.AUTO_ID })
      // Auto is back: the model turn answering the command picks a model once, and both of its steps (a tool call,
      // then the reply) run on that model. Auto itself never reaches the gateway (the fake throws if it does).
      state.catalog = withAuto
      state.replies = ["tool"]
      const { result, errors } = yield* errorsDuring(session.id, prompt.loop({ sessionID: session.id }))
      expect(Exit.isSuccess(result)).toBe(true)
      expect(errors).toEqual([])
      expect(chat().map((item) => item.model)).toEqual([middle.id, middle.id])
      expect((yield* users(session.id)).at(-1)).toMatchObject({ model: { modelID: middle.id }, selected: autoRef })
      const assistants = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) =>
        message.info.role === "assistant" && message.info.modelID !== ModelPlans.AUTO_ID ? [message.info.modelID] : [],
      )
      expect(assistants.map(String)).toEqual([middle.id, middle.id])
    }),
  { config: { shell: "/bin/sh" } },
)

it.instance(
  "the turn after a shell message that kept Auto fails with Auto's notice and sends nothing while Auto still cannot pick",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: auto,
        noReply: true,
        parts: [{ type: "text", text: "Start" }],
      })
      state.catalog = withoutAuto
      yield* prompt.shell({ sessionID: session.id, agent: "build", command: "echo hi" })
      const { errors } = yield* errorsDuring(session.id, prompt.loop({ sessionID: session.id }))
      expect(errors).toHaveLength(1)
      expect(state.sent).toEqual([])
      // Nothing was stored: the message still names Auto for a later turn.
      expect((yield* users(session.id)).at(-1)).not.toHaveProperty("selected")
    }),
  { config: { shell: "/bin/sh" } },
)

free.instance("a free conversation's subtask stays on the free model, even when the subtask names Codium Auto", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    // Auto could not pick a model now; a free conversation never asks it to.
    state.catalog = withoutAuto
    const { result, errors } = yield* errorsDuring(
      session.id,
      Effect.gen(function* () {
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: freeRef,
          noReply: true,
          parts: [
            {
              type: "subtask",
              prompt: "look into the cache key path",
              description: "inspect bug",
              agent: "general",
              model: auto,
            },
          ],
        })
        yield* prompt.loop({ sessionID: session.id })
      }),
    )
    expect(Exit.isSuccess(result)).toBe(true)
    expect(errors).toEqual([])
    const subtask = (yield* sessions.messages({ sessionID: session.id })).find(
      (message) => message.info.role === "assistant" && message.info.agent === "general",
    )
    expect(subtask?.info).toMatchObject({ providerID: freeRef.providerID, modelID: freeRef.modelID })
    const general = answered.filter((item) => item.agent === "general")
    expect(general.length).toBeGreaterThan(0)
    expect(general.every((item) => item.providerID === "vector" && item.modelID === freeModel.id)).toBe(true)
    expect(state.sent).toEqual([])
  }),
)

// A conversation on a provider of the user's own (a workspace's provider settings apply once it is trusted), with one
// helper agent set to Codium Auto. Every model call in this stack is answered in-process, so the loopback URL is never
// reached.
const elsewhere = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }
const onAuto = (agent: Partial<ConfigV1.Info>["agent"]): { trusted: true; config: Partial<ConfigV1.Info> } => ({
  trusted: true,
  config: {
    agent,
    provider: {
      lmstudio: {
        name: "Test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 2, output: 8 },
          },
        },
        options: { apiKey: "test-key", baseURL: "http://127.0.0.1:9/v1" },
      },
    },
  },
})
const autoSelector = `${ModelPlans.PROVIDER_ID}/${ModelPlans.AUTO_ID}`

free.instance(
  "a title agent set to Codium Auto titles on Auto's helper model, or not at all, and never sends Auto",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const titled = Effect.fn("test.titled")(function* () {
        const session = yield* sessions.create({})
        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: elsewhere,
          size: "standard",
          parts: [{ type: "text", text: "Rework the cache layer" }],
        })
        yield* prompt.awaitTitles()
        const title = answered.filter((item) => item.agent === "title")
        answered.length = 0
        return title
      })
      // Auto's floor, though the conversation is on another provider.
      expect(yield* titled()).toEqual([{ agent: "title", providerID: ModelPlans.PROVIDER_ID, modelID: floor.id }])
      // A plan with no usable Auto has no helper model: no title request, not one on the conversation's own model.
      state.catalog = withoutAuto
      expect(yield* titled()).toEqual([])
    }),
  onAuto({ title: { model: autoSelector } }),
)

free.instance(
  "a compaction agent set to Codium Auto summarises on the model Auto picks, never on Auto itself",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const compaction = yield* SessionCompaction.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: elsewhere,
        size: "standard",
        parts: [{ type: "text", text: "Explain the cache layer" }],
      })
      yield* compaction.create({ sessionID: session.id, agent: "build", model: elsewhere, auto: false })
      const { result, errors } = yield* errorsDuring(session.id, prompt.loop({ sessionID: session.id }))
      expect(Exit.isSuccess(result)).toBe(true)
      expect(errors).toEqual([])
      expect(answered.filter((item) => item.agent === "compaction")).toEqual([
        { agent: "compaction", providerID: ModelPlans.PROVIDER_ID, modelID: middle.id },
      ])
      const summary = (yield* sessions.messages({ sessionID: session.id })).find(
        (message) => message.info.role === "assistant" && message.info.summary,
      )
      expect(summary?.info).toMatchObject({ providerID: ModelPlans.PROVIDER_ID, modelID: middle.id })
      expect(answered.every((item) => item.modelID !== ModelPlans.AUTO_ID)).toBe(true)
    }),
  onAuto({ compaction: { model: autoSelector } }),
)

free.instance(
  "a compaction agent set to Codium Auto stops with Auto's notice and sends nothing while Auto cannot pick",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const compaction = yield* SessionCompaction.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Pinned" })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: elsewhere,
        size: "standard",
        parts: [{ type: "text", text: "Explain the cache layer" }],
      })
      answered.length = 0
      state.catalog = withoutAuto
      yield* compaction.create({ sessionID: session.id, agent: "build", model: elsewhere, auto: false })
      const { errors } = yield* errorsDuring(session.id, prompt.loop({ sessionID: session.id }))
      expect(errors.map((error) => ModelPlanStatus.failureAction(error))).toEqual(["unavailable"])
      expect(JSON.stringify(errors[0])).toContain("Codium Auto is not available")
      // No summary was requested, on Auto, on the session's own model or on any other.
      expect(answered).toEqual([])
    }),
  onAuto({ compaction: { model: autoSelector } }),
)

const sessionID = SessionID.make("ses_codium_auto")
const text = (messageID: MessageID, value: string): SessionV1.TextPart => ({
  id: PartID.ascending(),
  sessionID,
  messageID,
  type: "text",
  text: value,
})
const assistant = (id: string, input: { tokens: number; summary?: boolean; parts?: SessionV1.Part[] }) => {
  const info: SessionV1.Assistant = {
    id: MessageID.make(id),
    sessionID,
    role: "assistant",
    parentID: MessageID.make("msg_000"),
    modelID: ModelV2.ID.make(middle.id),
    providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID),
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    time: { created: 0, completed: 1 },
    finish: "stop",
    ...(input.summary ? { summary: true } : {}),
    tokens: { input: input.tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  return { info, parts: input.parts ?? [] }
}

test("the context Auto guards is the newest measured request after the boundary plus what came after it", () => {
  const read: SessionV1.ToolPart = {
    id: PartID.ascending(),
    sessionID,
    messageID: MessageID.make("msg_003"),
    type: "tool",
    callID: "call_1",
    tool: "read",
    // "{}" and 3,998 characters of output: 1,000 tokens the measured request did not send.
    state: {
      status: "completed",
      input: {},
      output: "x".repeat(3_998),
      title: "",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  }
  const user = {
    info: {
      id: MessageID.make("msg_004"),
      sessionID,
      role: "user" as const,
      time: { created: 2 },
      agent: "build",
      model: { providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID), modelID: ModelV2.ID.make(middle.id) },
    },
    parts: [text(MessageID.make("msg_004"), "y".repeat(400))],
  }
  const visible = [
    // The summary's own request read the history it replaced; it is not this context.
    assistant("msg_002", { tokens: 150_000, summary: true, parts: [text(MessageID.make("msg_002"), "summary")] }),
    assistant("msg_003", { tokens: 20_000, parts: [read] }),
    user,
  ]
  expect(SessionCodiumAuto.contextTokens(visible, [text(MessageID.make("msg_005"), "z".repeat(40))])).toBe(
    20_000 + 1_000 + 100 + 10,
  )
  // A provider that reports no usage: the estimate of the whole history is the floor.
  const earlier = {
    ...user,
    info: { ...user.info, id: MessageID.make("msg_001") },
    parts: [text(MessageID.make("msg_001"), "q".repeat(800))],
  }
  const unmeasured = [earlier, assistant("msg_003", { tokens: 0, parts: [read] }), user]
  expect(SessionCodiumAuto.contextTokens(unmeasured)).toBe(200 + 1_000 + 100)
  expect(SessionCodiumAuto.isAuto(autoRef)).toBe(true)
  expect(SessionCodiumAuto.isAuto({ providerID: ModelPlans.PROVIDER_ID, modelID: middle.id })).toBe(false)
})

it.instance("a Vectorscope review's Codium requests say they are for a review", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const review = yield* sessions.create({ title: "Pinned", internal: "vectorscope.review" })
    yield* prompt.prompt({
      sessionID: review.id,
      agent: "review",
      model: { providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID), modelID: ModelV2.ID.make(middle.id) },
      parts: [{ type: "text", text: "Review the uncommitted changes" }],
    })
    expect(state.sent.map((item) => item.purpose)).toEqual(["review"])
  }),
)
