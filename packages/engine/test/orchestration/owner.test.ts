import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { LLMEvent } from "@vectordevai/llm"
import { WorkflowOwner } from "@/orchestration/owner"
import { WorkflowRuns } from "@/orchestration/runs"
import { WorkflowMarkers } from "@/orchestration/constants"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { ref, spec } from "../tool/workflow-fixture"

const built = WorkflowPlan.build(spec, { agents: [{ name: "explore", allowed: true, writes: false }], source: "owner" })
if (!built.plan) throw new Error("Owner test workflow must be valid")
const plan = built.plan
const controls = {
  preview: Effect.void as Effect.Effect<void>,
  contexts: [] as WorkflowRuns.PlanContext[],
  launches: 0,
  reject: undefined as "preview" | "launch" | undefined,
  prompts: [] as { model: string; messages: unknown }[],
}
const fake: WorkflowRuns.Interface = {
  resolve: (_sessionID, input) => Effect.succeed({ input, stored: false }),
  preview: (_input, context) =>
    Effect.gen(function* () {
      controls.contexts.push(context)
      yield* controls.preview
      if (controls.reject === "preview")
        return { ok: false, issues: [{ path: "/stages", message: "Invalid test workflow" }], warnings: [] }
      return { ok: true, plan, issues: [], warnings: [] }
    }),
  validate: () => Effect.succeed({ ok: true, plan, issues: [], warnings: [] }),
  launch: () =>
    controls.reject === "launch"
      ? Effect.fail(new WorkflowRuns.Error({ code: "limit", message: "Test run limit" }))
      : Effect.sync(() => {
          controls.launches++
          return { runID: "ses_workflow_fixture", title: plan.title, plan }
        }),
}
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([WorkflowOwner.node, Session.node, SessionPrompt.node, SessionRunState.node, SessionStatus.node]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ backgroundSubagents: true })],
      [WorkflowRuns.node, Layer.succeed(WorkflowRuns.Service, fake)],
      [
        LLM.node,
        Layer.succeed(LLM.Service, {
          stream: (input) => {
            controls.prompts.push({ model: input.model.id, messages: input.messages })
            input.answering?.()
            return Stream.make(
              LLMEvent.textStart({ id: "reply" }),
              LLMEvent.textDelta({ id: "reply", text: "Answered the human input." }),
              LLMEvent.textEnd({ id: "reply" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop" }),
              LLMEvent.finish({ reason: "stop" }),
            )
          },
        }),
      ],
    ],
  ),
)
const config = testProviderConfig("http://127.0.0.1:1")
const options = {
  trusted: true,
  config: {
    ...config,
    provider: {
      lmstudio: {
        ...config.provider.lmstudio,
        models: {
          ...config.provider.lmstudio.models,
          "second-model": {
            ...config.provider.lmstudio.models["test-model"],
            id: "second-model",
            name: "Second model",
          },
        },
      },
    },
  },
}
afterEach(async () => {
  controls.preview = Effect.void
  controls.contexts.length = 0
  controls.prompts.length = 0
  controls.launches = 0
  controls.reject = undefined
  await disposeAllInstances()
})

it.instance(
  "a human prompt arriving during owner validation gets its own model turn and keeps its selection",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const owner = yield* WorkflowOwner.Service
      const prompts = yield* SessionPrompt.Service
      const status = yield* SessionStatus.Service
      const parent = yield* sessions.create({ title: "Owner race" })
      yield* sessions.setAgentModel({
        sessionID: parent.id,
        agent: "build",
        model: { providerID: ref.providerID, id: ref.modelID },
        time: Date.now(),
      })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      controls.preview = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      const launch = yield* owner.start(parent.id, { spec: JSON.stringify(spec) }).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(Deferred.await(entered), "Owner never reached preview", "8 seconds")
      expect((yield* status.get(parent.id)).type).toBe("busy")
      const humanID = MessageID.ascending()
      const human = yield* prompts
        .prompt({
          sessionID: parent.id,
          messageID: humanID,
          model: { ...ref, modelID: ModelV2.ID.make("second-model") },
          parts: [{ type: "text", text: "Also explain the change to me." }],
        })
        .pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: parent.id })
          .pipe(Effect.map((messages) => (messages.some((message) => message.info.id === humanID) ? true : undefined))),
        "Concurrent human message was not saved",
      )
      expect(controls.prompts).toHaveLength(0)
      yield* Deferred.succeed(release, undefined)
      yield* awaitWithTimeout(Fiber.join(launch), "Owner did not finish")
      const reply = yield* awaitWithTimeout(Fiber.join(human), "Concurrent prompt was swallowed")
      expect(reply.info.role).toBe("assistant")
      if (reply.info.role === "assistant") expect(reply.info.parentID).toBe(humanID)
      expect(controls.prompts).toHaveLength(1)
      expect(JSON.stringify(controls.prompts[0].messages)).toContain("Also explain the change to me.")
      expect(controls.prompts[0].model).toBe("second-model")
      expect(String((yield* sessions.get(parent.id)).model?.id)).toBe("second-model")
    }),
  options,
)

for (const edge of ["before launch", "after launch"] as const)
  it.instance(
    `cancellation ${edge} settles every synthetic assistant and workflow tool`,
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const owner = yield* WorkflowOwner.Service
        const state = yield* SessionRunState.Service
        const parent = yield* sessions.create({ title: `Cancel ${edge}` })
        yield* sessions.setAgentModel({
          sessionID: parent.id,
          agent: "build",
          model: { providerID: ref.providerID, id: ref.modelID },
          time: Date.now(),
        })
        const entered = yield* Deferred.make<void>()
        const originalMessages = sessions.messages
        const originalPart = sessions.updatePart
        let held = false
        if (edge === "before launch")
          Object.assign(sessions, {
            messages: (input: Parameters<typeof originalMessages>[0]) =>
              originalMessages(input).pipe(
                Effect.tap((messages) => {
                  if (
                    held ||
                    input.sessionID !== parent.id ||
                    !messages.some((message) =>
                      message.parts.some(
                        (part) =>
                          part.type === "tool" &&
                          part.state.status !== "pending" &&
                          part.state.metadata?.[WorkflowMarkers.OWNER_START],
                      ),
                    )
                  )
                    return Effect.void
                  held = true
                  return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                }),
              ),
          })
        else
          Object.assign(sessions, {
            updatePart: (part: Parameters<typeof originalPart>[0]) => {
              if (!held && part.type === "tool" && part.tool === "workflow" && part.state.status === "completed") {
                held = true
                return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              }
              return originalPart(part)
            },
          })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Object.assign(sessions, { messages: originalMessages, updatePart: originalPart })),
        )
        const launch = yield* owner
          .start(parent.id, { spec: JSON.stringify(spec) })
          .pipe(Effect.exit, Effect.forkScoped)
        yield* awaitWithTimeout(Deferred.await(entered), "Cancellation edge was not reached", "8 seconds")
        yield* awaitWithTimeout(state.cancel(parent.id), "Owner cancellation did not drain")
        yield* awaitWithTimeout(Fiber.join(launch), "Owner request did not stop")
        const history = yield* originalMessages({ sessionID: parent.id })
        const assistant = history.find((message) => message.info.role === "assistant")!
        expect(assistant.info.role === "assistant" && assistant.info.time.completed).toBeNumber()
        expect(assistant.info.role === "assistant" && assistant.info.error?.name).toBe("MessageAbortedError")
        expect(assistant.parts.find((part) => part.type === "tool")?.type).toBe("tool")
        expect(assistant.parts.filter((part) => part.type === "tool").map((part) => part.state.status)).toEqual([
          "error",
        ])
        expect(controls.launches).toBe(edge === "before launch" ? 0 : 1)
        expect(controls.prompts).toHaveLength(0)
      }),
    options,
  )

it.instance(
  "owner starts plan as the default agent without changing a different selected main agent",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const owner = yield* WorkflowOwner.Service
      const parent = yield* sessions.create({ title: "Default workflow caller" })
      yield* sessions.setAgentModel({
        sessionID: parent.id,
        agent: "plan",
        model: { providerID: ref.providerID, id: ref.modelID },
        time: Date.now(),
      })
      yield* owner.start(parent.id, { spec: JSON.stringify(spec) })
      expect(controls.contexts[0].agent).toBe("build")
      expect((yield* sessions.get(parent.id)).agent).toBe("plan")
      expect(controls.prompts).toHaveLength(0)
    }),
  options,
)

for (const rejected of ["preview", "launch"] as const)
  it.instance(
    `a rejected owner ${rejected} does not consume a concurrent human prompt`,
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const owner = yield* WorkflowOwner.Service
        const prompts = yield* SessionPrompt.Service
        const parent = yield* sessions.create({ title: "Rejected owner handoff" })
        yield* sessions.setAgentModel({
          sessionID: parent.id,
          agent: "build",
          model: { providerID: ref.providerID, id: ref.modelID },
          time: Date.now(),
        })
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        controls.preview = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        controls.reject = rejected
        const launch = yield* owner
          .start(parent.id, { spec: JSON.stringify(spec) })
          .pipe(Effect.result, Effect.forkScoped)
        yield* awaitWithTimeout(Deferred.await(entered), "Owner did not enter preview", "8 seconds")
        const humanID = MessageID.ascending()
        const human = yield* prompts
          .prompt({
            sessionID: parent.id,
            messageID: humanID,
            model: ref,
            parts: [{ type: "text", text: "Answer this even if the workflow cannot start." }],
          })
          .pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          sessions
            .messages({ sessionID: parent.id })
            .pipe(
              Effect.map((messages) => (messages.some((message) => message.info.id === humanID) ? true : undefined)),
            ),
          "Human message was not saved",
        )
        yield* Deferred.succeed(release, undefined)
        const refused = yield* awaitWithTimeout(Fiber.join(launch), "Owner did not refuse")
        expect(refused._tag).toBe("Failure")
        if (refused._tag === "Failure") expect(refused.failure.code).toBe(rejected === "preview" ? "invalid" : "limit")
        const answered = yield* awaitWithTimeout(Fiber.join(human), "Human prompt was consumed by owner failure")
        expect(answered.info.role === "assistant" && answered.info.parentID).toBe(humanID)
        expect(controls.prompts).toHaveLength(1)
        expect(JSON.stringify(controls.prompts[0].messages)).toContain("Answer this even if")
      }),
    options,
  )
