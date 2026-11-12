import { afterEach, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { LLMEvent } from "@vectordevai/llm"
import { WorkflowOwner } from "@/orchestration/owner"
import { WorkflowRuns } from "@/orchestration/runs"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { LLM } from "@/session/llm"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { spec } from "../tool/workflow-fixture"

const token = "vct_owner-workflow-fixture.token"
const model = { id: "fixture/default", name: "Codium fixture", contextLength: 100_000, maxOutputTokens: 8_192 }
const catalog: ModelPlans.Catalog = {
  enabled: true,
  plan: "vector-50",
  models: [
    { ...model, role: "default" },
    {
      id: ModelPlans.AUTO_ID,
      name: "Codium Auto",
      contextLength: model.contextLength,
      maxOutputTokens: model.maxOutputTokens,
      auto: { floor: model.id, default: model.id, ceiling: model.id },
    },
  ],
}
const auto = { providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID), modelID: ModelV2.ID.make(ModelPlans.AUTO_ID) }
const selectedFree = FREE_MODEL_FALLBACKS[0]!
const free = { providerID: ProviderV2.ID.make("vector"), modelID: ModelV2.ID.make(selectedFree.id) }
const calls: { agent: string; provider: string; model: string }[] = []
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([WorkflowOwner.node, WorkflowRuns.node, Session.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ backgroundSubagents: true, noteQuietMs: 10, noteHoldMs: 30 })],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "vector" ? token : undefined),
      }),
    ],
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: true, updatedAt: 1, models: [...FREE_MODEL_FALLBACKS] }),
        forKey: () => Effect.succeed([]),
        trainingConsent: () => Effect.succeed(true),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
    ],
    [
      ModelPlans.node,
      Layer.succeed(ModelPlans.Service, {
        catalog: (account) => Effect.succeed(account === token ? catalog : { enabled: false, models: [] }),
        request: async () => {
          throw new Error("No gateway transport is allowed in this fixture")
        },
      }),
    ],
    [
      LLM.node,
      Layer.succeed(LLM.Service, {
        stream: (input) => {
          calls.push({ agent: input.agent.name, provider: input.model.providerID, model: input.model.id })
          input.answering?.()
          return Stream.make(
            LLMEvent.textStart({ id: "answer" }),
            LLMEvent.textDelta({ id: "answer", text: "Review complete." }),
            LLMEvent.textEnd({ id: "answer" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          )
        },
      }),
    ],
  ]),
)
afterEach(async () => {
  calls.length = 0
  await disposeAllInstances()
})
const options = { trusted: true, config: testProviderConfig("http://127.0.0.1:1") }

it.instance(
  "owner Auto preview is explicit and actual workflow children resolve on Codium before inference",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const owner = yield* WorkflowOwner.Service
      const runs = yield* WorkflowRuns.Service
      const parent = yield* sessions.create({ title: "Owner Auto" })
      yield* sessions.setAgentModel({
        sessionID: parent.id,
        agent: "build",
        model: { providerID: auto.providerID, id: auto.modelID },
        time: Date.now(),
      })
      const input = { spec: JSON.stringify(spec) }
      const preview = yield* runs.preview(input, { agent: "build", model: auto })
      expect(preview.ok).toBe(true)
      expect(preview.plan?.stages[0].model).toBe(`${auto.providerID}/${auto.modelID}`)
      expect(preview.warnings.some((warning) => warning.message.includes("Children that inherit Auto"))).toBe(true)
      const started = yield* owner.start(parent.id, input)
      const detail = yield* pollWithTimeout(
        owner.get(parent.id, SessionID.make(started.runID), true).pipe(
          Effect.map((detail) => {
            const status = detail.task.status
            return status === "completed" || status === "failed" || status === "stopped" ? detail : undefined
          }),
        ),
        "Auto workflow did not settle",
        "15 seconds",
      )
      expect(detail.task.status, detail.report).toBe("completed")
      expect(calls).toEqual([{ agent: "explore", provider: ModelPlans.PROVIDER_ID, model: model.id }])
      expect(String((yield* sessions.get(parent.id)).model?.id)).toBe(ModelPlans.AUTO_ID)
    }),
  options,
)

it.instance(
  "owner Auto refuses an unapproved explicit provider override before transcript or child creation",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const owner = yield* WorkflowOwner.Service
      const parent = yield* sessions.create({ title: "Auto policy" })
      yield* sessions.setAgentModel({
        sessionID: parent.id,
        agent: "build",
        model: { providerID: auto.providerID, id: auto.modelID },
        time: Date.now(),
      })
      const denied = yield* owner
        .start(parent.id, {
          spec: JSON.stringify({ ...spec, defaults: { ...spec.defaults, model: "lmstudio/test-model" } }),
        })
        .pipe(Effect.flip)
      expect(denied.code).toBe("invalid")
      expect(denied.message).toContain("not on your provider")
      expect(yield* sessions.messages({ sessionID: parent.id })).toHaveLength(0)
      expect(yield* sessions.children(parent.id)).toHaveLength(0)
      expect(calls).toHaveLength(0)
    }),
  options,
)

it.instance(
  "owner revalidation preserves a session free selection over a paid default-agent model",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const owner = yield* WorkflowOwner.Service
      const parent = yield* sessions.create({ title: "Free workflow" })
      yield* sessions.setAgentModel({
        sessionID: parent.id,
        agent: "build",
        model: { providerID: free.providerID, id: free.modelID },
        time: Date.now(),
      })
      const input = { spec: JSON.stringify({ ...spec, defaults: { ...spec.defaults, model: "lmstudio/test-model" } }) }
      expect((yield* owner.validate(input)).ok).toBe(true)
      const denied = yield* owner.start(parent.id, input).pipe(Effect.flip)
      expect(denied.code).toBe("invalid")
      expect(denied.message).toContain("free model")
      expect(yield* sessions.messages({ sessionID: parent.id })).toHaveLength(0)
      expect(calls).toHaveLength(0)
    }),
  { ...options, config: { ...options.config, agent: { build: { model: "lmstudio/test-model" } } } },
)
