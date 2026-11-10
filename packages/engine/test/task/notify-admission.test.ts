import { afterEach, expect } from "bun:test"
import { Deferred, Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { LLMEvent } from "@vectordevai/llm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionTaskSize } from "@/session/task-size"
import { SessionStatus } from "@/session/status"
import { LLM } from "@/session/llm"
import { MessageID, PartID } from "@/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { TaskManager } from "@/task/manager"
import { TaskNotify } from "@/task/notify"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"
import { ref } from "../tool/workflow-fixture"

const calls: string[] = []
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      TaskNotify.node,
      TaskManager.node,
      Session.node,
      SessionPrompt.node,
      SessionStatus.node,
      SpendGuard.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ backgroundSubagents: true, noteQuietMs: 10, noteHoldMs: 30 })],
      [
        LLM.node,
        Layer.succeed(LLM.Service, {
          stream: (input) => {
            calls.push(input.agent.name)
            input.answering?.()
            return Stream.make(
              LLMEvent.textStart({ id: "reply" }),
              LLMEvent.textDelta({ id: "reply", text: "A fresh answer." }),
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
afterEach(async () => {
  calls.length = 0
  await disposeAllInstances()
})

for (const action of ["stop", "stop then human unfence", "spend stop", "continue"] as const)
  it.instance(
    `a persisted pending result note respects ${action} at actual runner admission`,
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompts = yield* SessionPrompt.Service
        const notify = yield* TaskNotify.Service
        const manager = yield* TaskManager.Service
        const status = yield* SessionStatus.Service
        const guard = yield* SpendGuard.Service
        const parent = yield* sessions.create({ title: "Pending note admission" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: parent.id,
          role: "user",
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: parent.id,
          messageID: user.id,
          type: "text",
          text: "Delegate a review and summarize it.",
        })
        const launch = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: parent.id,
          role: "assistant",
          parentID: user.id,
          agent: "build",
          mode: "build",
          providerID: ref.providerID,
          modelID: ref.modelID,
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
          time: { created: Date.now(), completed: Date.now() },
        })
        const child = yield* sessions.create({
          parentID: parent.id,
          title: "Finished review",
          metadata: {
            subagent: {
              kind: "subagent",
              custom: false,
              agent: "general",
              title: "Review",
              parentSessionID: parent.id,
              parentMessageID: launch.id,
              model: ref,
              background: true,
              status: "completed",
              startedAt: Date.now(),
              runtimeID: SubagentLifecycle.RUNTIME_ID,
              attempt: 1,
            },
          },
        })
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const delivered = yield* Deferred.make<void>()
        let noteID: MessageID | undefined
        let held = false
        const touch = sessions.touch
        Object.assign(sessions, {
          touch: (id: Parameters<typeof touch>[0]) =>
            Effect.gen(function* () {
              yield* touch(id)
              if (id !== parent.id || held) return
              const note = (yield* sessions.messages({ sessionID: id })).find((message) =>
                message.parts.some(
                  (part) => part.type === "text" && part.metadata?.taskNotification?.taskID === child.id,
                ),
              )
              if (!note) return
              noteID = note.info.id
              held = true
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }),
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => Object.assign(sessions, { touch })))
        const ops: TaskPromptOps = {
          cancel: prompts.cancel,
          resolvePromptParts: prompts.resolvePromptParts,
          prompt: (input) =>
            prompts.prompt(input).pipe(Effect.orDie, Effect.ensuring(Deferred.succeed(delivered, undefined))),
        }
        yield* notify.enqueue({
          parentID: parent.id,
          agent: "build",
          ops,
          note: {
            kind: "result",
            taskID: child.id,
            launchID: launch.id,
            attempt: 1,
            state: "completed",
            text: "<task-notification>Review complete.</task-notification>",
            wake: true,
          },
        })
        yield* awaitWithTimeout(
          Deferred.await(entered),
          "The result note was not persisted before admission",
          "8 seconds",
        )
        expect(calls).toHaveLength(0)
        expect((yield* status.get(parent.id)).type).toBe("idle")
        expect(noteID).toBeDefined()
        if (action === "stop" || action === "stop then human unfence") {
          const stopped = yield* manager.interrupt({ sessionID: parent.id, helpers: false }, ops)
          expect(stopped.aborted).toBe(false)
          if (action === "stop then human unfence")
            yield* prompts.prompt({
              sessionID: parent.id,
              agent: "build",
              model: ref,
              noReply: true,
              parts: [{ type: "text", text: "Keep this instruction for my next turn." }],
            })
          expect(yield* notify.canReply(parent.id, noteID!)).toBe(false)
        }
        if (action === "spend stop") {
          yield* guard.arm(parent.id, { usd: 1 })
          yield* guard.begin(parent.id)
          yield* guard.record(parent.id, {
            costKind: "priced",
            costUsd: 2,
            contextTokens: 0,
            cachedTokens: 0,
            continues: false,
            tools: [],
            patched: false,
          })
          expect((yield* guard.snapshot(parent.id))?.stopped).toBeDefined()
        }
        yield* Deferred.succeed(release, undefined)
        yield* awaitWithTimeout(Deferred.await(delivered), "The pending note never settled", "8 seconds")
        const note = (yield* sessions.messages({ sessionID: parent.id })).find((message) => message.info.id === noteID)!
        const part = note.parts.find((part) => part.type === "text")!
        expect(part.type === "text" && part.metadata?.taskNotification?.attempt).toBe(1)
        if (action === "continue") {
          expect(calls).toEqual(["build"])
          expect(part.type === "text" && part.metadata?.[SessionTaskSize.QUIET]).toBeUndefined()
        } else {
          expect(calls).toHaveLength(0)
          expect(part.type === "text" && part.metadata?.[SessionTaskSize.QUIET]).toBe(true)
          expect(part.type === "text" && part.metadata?.taskNotification?.quiet).toBe(true)
        }
        // Completed prompt cleanup releases registry ownership; the historical message's public metadata is no authority.
        expect(
          yield* pollWithTimeout(
            notify.canReply(parent.id, noteID!).pipe(Effect.map((ok) => (ok ? true : undefined))),
            "The completed delivery did not release its registry entry",
          ),
        ).toBe(true)
        if (action === "stop" || action === "stop then human unfence") {
          yield* prompts.prompt({
            sessionID: parent.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "Now answer my next question." }],
          })
          expect(calls).toEqual(["build"])
        }
      }),
    { trusted: true, config: testProviderConfig("http://127.0.0.1:1") },
  )
