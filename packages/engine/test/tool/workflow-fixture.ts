import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { Database } from "@vectordevai/core/database/database"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { WorkflowRuns } from "@/orchestration/runs"
import { BackgroundJob } from "@/background/job"
import { TaskLimits } from "@/task/limits"
import { TaskManager } from "@/task/manager"
import { TaskNotify } from "@/task/notify"
import { WorkflowMarkers } from "@/orchestration/constants"
import { Tool } from "@/tool/tool"
import type { TaskPromptOps } from "@/tool/task"
import type { SessionPrompt } from "@/session/prompt"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"

export const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      Session.node,
      WorkflowRuns.node,
      BackgroundJob.node,
      TaskLimits.node,
      TaskManager.node,
      TaskNotify.node,
      FreeModelGuests.node,
      Database.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      RuntimeFlags.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ backgroundSubagents: true, noteQuietMs: 10, noteHoldMs: 30, ...flags })],
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
    ],
  )
export const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }
export const spec = {
  version: 1,
  title: "Review a workflow",
  defaults: { agent: "explore" },
  stages: [{ id: "a", prompt: "Review the file" }],
}
export const fixture = Effect.fn("WorkflowTest.fixture")(function* () {
  const sessions = yield* Session.Service
  const registry = yield* ToolRegistry.Service
  const instance = yield* InstanceState.context
  const parent = yield* sessions.create({ title: "Workflow parent" })
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
    messageID: user.id,
    sessionID: parent.id,
    type: "text",
    text: "Run this workflow.",
  })
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    ...{ modelID: ref.modelID, providerID: ref.providerID },
    path: { cwd: instance.directory, root: instance.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  })
  const prompts: SessionPrompt.PromptInput[] = []
  const asks: Parameters<Tool.Context["ask"]>[0][] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: (input) =>
      Effect.gen(function* () {
        prompts.push(input)
        const user = yield* sessions.updateMessage({
          id: input.messageID ?? MessageID.ascending(),
          sessionID: input.sessionID,
          role: "user",
          agent: input.agent ?? "explore",
          model: input.model ?? ref,
          time: { created: Date.now() },
        })
        for (const part of input.parts)
          if (part.type === "text")
            yield* sessions.updatePart({
              ...part,
              id: PartID.ascending(),
              messageID: user.id,
              sessionID: input.sessionID,
            })
        if (input.noReply) return { info: user, parts: [] }
        const reply: SessionV1.Assistant = {
          id: MessageID.ascending(),
          sessionID: input.sessionID,
          role: "assistant",
          parentID: user.id,
          agent: input.agent ?? "explore",
          mode: input.agent ?? "explore",
          providerID: input.model?.providerID ?? ref.providerID,
          modelID: input.model?.modelID ?? ref.modelID,
          path: { cwd: instance.directory, root: instance.directory },
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        yield* sessions.updateMessage(reply)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: reply.id,
          sessionID: reply.sessionID,
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: reply.tokens,
        })
        const answer = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: reply.id,
          sessionID: reply.sessionID,
          type: "text",
          text: "Checked the file.",
        })
        return { info: reply, parts: [answer] }
      }),
  }
  const ctx: Tool.Context = {
    sessionID: parent.id,
    messageID: message.id,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    extra: { promptOps: ops, [WorkflowMarkers.TASK_OFFERED]: true },
    metadata: () => Effect.void,
    ask: (ask) =>
      Effect.sync(() => {
        asks.push(ask)
      }),
  }
  return {
    sessions,
    parent,
    message,
    ctx,
    ops,
    prompts,
    asks,
    task: () => registry.named().pipe(Effect.map((named) => named.task)),
  }
})
