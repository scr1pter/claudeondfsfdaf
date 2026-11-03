import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { SecondOpinion } from "../../src/session/second-opinion"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// WP A35: Second opinion. The judge gate's pure choice of the judge's model, and the task tool running the gate's own
// judge launch on it.

afterEach(async () => {
  await disposeAllInstances()
})

const PLAN = "vector-plan"
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017"
const SOL = "openai/gpt-6.1-sol"
const LUNA = "openai/gpt-6-luna"
const ARGON = "google/gemini-4-argon"

// The Codium provider's entries as Provider.list() lists them for a Pro account (ModelV2.Codium).
const models = {
  [DEEPSEEK]: { id: DEEPSEEK, codium: { lab: "deepseek", role: "default", judge: SOL } },
  [LUNA]: { id: LUNA, codium: { lab: "openai", role: "floor", judge: ARGON } },
  [SOL]: { id: SOL, codium: { lab: "openai", judge: ARGON } },
  [ARGON]: { id: ARGON, codium: { lab: "google", judge: SOL } },
}

const worker = (modelID: string) => ({ providerID: PLAN, modelID })

describe("SecondOpinion.judgeModel", () => {
  test("a Codium worker with the setting on is judged on its listed judge from another lab", () => {
    expect(SecondOpinion.judgeModel({ worker: worker(DEEPSEEK), models, configured: false, on: true })).toEqual({
      providerID: PLAN,
      modelID: SOL,
    })
    expect(SecondOpinion.judgeModel({ worker: worker(LUNA), models, configured: false, on: true })).toEqual({
      providerID: PLAN,
      modelID: ARGON,
    })
  })

  test("nothing changes unless every condition holds", () => {
    const base = { worker: worker(DEEPSEEK), models, configured: false, on: true }
    // The setting is off.
    expect(SecondOpinion.judgeModel({ ...base, on: false })).toBeUndefined()
    // agent.judge.model is configured: the person's own judge wins.
    expect(SecondOpinion.judgeModel({ ...base, configured: true })).toBeUndefined()
    // The worker is not a Codium model: own keys keep judging on their own model.
    expect(
      SecondOpinion.judgeModel({ ...base, worker: { providerID: "anthropic", modelID: "claude-sonnet-4" } }),
    ).toBeUndefined()
    // No catalog, or no judge listed for the worker (Plus lists none).
    expect(SecondOpinion.judgeModel({ ...base, models: undefined })).toBeUndefined()
    expect(
      SecondOpinion.judgeModel({ ...base, models: { [DEEPSEEK]: { id: DEEPSEEK, codium: { lab: "deepseek" } } } }),
    ).toBeUndefined()
    // The judge the catalog names is not listed, or the plan cannot use it, or it is manual-only or Auto.
    expect(SecondOpinion.judgeModel({ ...base, models: { [DEEPSEEK]: models[DEEPSEEK] } })).toBeUndefined()
    for (const extra of [
      { locked: { plan: "vector-100", name: "Max" } },
      { manualOnly: true },
      { auto: { floor: LUNA, default: DEEPSEEK, ceiling: SOL } },
    ])
      expect(
        SecondOpinion.judgeModel({
          ...base,
          models: { ...models, [SOL]: { id: SOL, codium: { lab: "openai", ...extra } } },
        }),
      ).toBeUndefined()
  })

  test("the judge must come from another lab Vector can name", () => {
    const base = { worker: worker(LUNA), configured: false, on: true }
    // A judge from the worker's own lab is no second opinion.
    expect(
      SecondOpinion.judgeModel({ ...base, models: { ...models, [LUNA]: { id: LUNA, codium: { judge: SOL } } } }),
    ).toBeUndefined()
    // Without a stated lab the vendor in the id decides; an id with no vendor names no lab.
    expect(
      SecondOpinion.judgeModel({
        ...base,
        models: {
          [LUNA]: { id: LUNA, codium: { judge: "mystery-model" } },
          "mystery-model": { id: "mystery-model", codium: {} },
        },
      }),
    ).toBeUndefined()
    expect(
      SecondOpinion.judgeModel({
        ...base,
        models: { [LUNA]: { id: LUNA, codium: { judge: ARGON } }, [ARGON]: { id: ARGON, codium: {} } },
      }),
    ).toEqual({ providerID: PLAN, modelID: ARGON })
  })
})

describe("SecondOpinion.enabled", () => {
  const user = (secondOpinion?: boolean): SessionV1.WithParts => ({
    info: {
      id: MessageID.ascending(),
      sessionID: SessionID.make("ses_second_opinion"),
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make(PLAN), modelID: ModelV2.ID.make(DEEPSEEK) },
      ...(secondOpinion === undefined ? {} : { secondOpinion }),
    },
    parts: [],
  })

  test("the newest message the person wrote in the judged work decides", () => {
    expect(SecondOpinion.enabled([user(true)])).toBe(true)
    expect(SecondOpinion.enabled([user(), user(true)])).toBe(true)
    // Turning it off takes effect with the next message, which the app no longer stamps.
    expect(SecondOpinion.enabled([user(true), user()])).toBe(false)
    expect(SecondOpinion.enabled([])).toBe(false)
  })
})

describe("SecondOpinion.fromExtra", () => {
  test("only a Codium model the gate handed over is taken", () => {
    expect(SecondOpinion.fromExtra({ [SecondOpinion.EXTRA]: { providerID: PLAN, modelID: SOL } })).toEqual({
      providerID: PLAN,
      modelID: SOL,
    })
    expect(SecondOpinion.fromExtra(undefined)).toBeUndefined()
    expect(SecondOpinion.fromExtra({ [SecondOpinion.EXTRA]: { providerID: "openai", modelID: SOL } })).toBeUndefined()
    expect(SecondOpinion.fromExtra({ [SecondOpinion.EXTRA]: { providerID: PLAN, modelID: " " } })).toBeUndefined()
    expect(SecondOpinion.fromExtra({ [SecondOpinion.EXTRA]: "vector-plan/openai/gpt-6.1-sol" })).toBeUndefined()
  })
})

const it = testEffect(
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
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

// A Codium build turn at high effort, as the judge gate's task message records it.
const seed = Effect.fn("SecondOpinionTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Second opinion" })
  const model = { providerID: ProviderV2.ID.make(PLAN), modelID: ModelV2.ID.make(DEEPSEEK) }
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: { ...model, variant: "high" },
    secondOpinion: true,
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
    modelID: model.modelID,
    providerID: model.providerID,
    variant: "high",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function recording(seen: SessionPrompt.PromptInput[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        seen.push(input)
        const id = MessageID.ascending()
        return {
          info: {
            id,
            role: "assistant" as const,
            parentID: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            mode: input.agent ?? "judge",
            agent: input.agent ?? "judge",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: input.model?.modelID ?? ModelV2.ID.make(DEEPSEEK),
            providerID: input.model?.providerID ?? ProviderV2.ID.make(PLAN),
            time: { created: Date.now() },
            finish: "stop",
          },
          parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text" as const, text: "PASS" }],
        }
      }),
  }
}

const launch = (input: {
  chat: { id: SessionID }
  assistant: { id: MessageID }
  seen: SessionPrompt.PromptInput[]
  subagent?: string
  extra?: Record<string, unknown>
}) =>
  Effect.gen(function* () {
    const def = yield* (yield* TaskTool).init()
    return yield* def.execute(
      {
        description: "Check the finished work",
        prompt: "Check the work against the request.",
        subagent_type: input.subagent ?? "judge",
        background: false,
      },
      {
        sessionID: input.chat.id,
        messageID: input.assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps: recording(input.seen), ...input.extra },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      },
    )
  })

const gate = { invokedAgents: ["judge"], [SecondOpinion.EXTRA]: { providerID: PLAN, modelID: SOL } }
// Model references as the task tool records them.
const ref = (providerID: string, modelID: string) => ({
  providerID: ProviderV2.ID.make(providerID),
  modelID: ModelV2.ID.make(modelID),
})

describe("the task tool and Second opinion", () => {
  it.instance("the gate's judge runs on the Second opinion judge at its entry's own effort", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const seen: SessionPrompt.PromptInput[] = []
      const result = yield* launch({ chat, assistant, seen, extra: gate })
      expect(seen).toHaveLength(1)
      expect(seen[0]?.agent).toBe("judge")
      expect(seen[0]?.model).toEqual(ref(PLAN, SOL))
      // The worker's high effort belongs to the worker's model; Sol's effort is part of its catalog entry.
      expect(seen[0]?.variant).toBeUndefined()
      expect(JSON.stringify("model" in result.metadata ? result.metadata.model : undefined)).toBe(
        JSON.stringify(ref(PLAN, SOL)),
      )
    }),
  )

  it.instance("a judge Vector's gate did not launch keeps the worker's model", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const seen: SessionPrompt.PromptInput[] = []
      // A model's own task call: no invokedAgents, so the handed-over model is ignored.
      yield* launch({ chat, assistant, seen, extra: { [SecondOpinion.EXTRA]: gate[SecondOpinion.EXTRA] } })
      // Another subagent the gate never launches as a judge.
      yield* launch({ chat, assistant, seen, subagent: "review", extra: { ...gate, invokedAgents: ["review"] } })
      expect(seen.map((input) => input.model)).toEqual([ref(PLAN, DEEPSEEK), ref(PLAN, DEEPSEEK)])
      expect(seen.map((input) => input.variant)).toEqual(["high", "high"])
    }),
  )

  it.instance(
    "a configured judge model wins over Second opinion",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const seen: SessionPrompt.PromptInput[] = []
        yield* launch({ chat, assistant, seen, extra: gate })
        expect(seen[0]?.model).toEqual(ref("lmstudio", "judge-model"))
      }),
    { config: { agent: { judge: { model: "lmstudio/judge-model" } } }, trusted: true },
  )
})
