import { afterEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { BackgroundJob } from "@/background/job"
import { EffectBridge } from "@/effect/bridge"
import { TaskManager } from "@/task/manager"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { TaskManageTool } from "@/tool/task-manage"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

afterEach(disposeAllInstances)
const it = testEffect(LayerNode.compile(ToolRegistry.node))

const fixture = Effect.fn("TaskManageAbortTest.fixture")(function* () {
  const sessions = yield* Session.Service
  const manager = yield* TaskManager.Service
  const jobs = yield* BackgroundJob.Service
  const root = yield* sessions.create()
  const child = yield* sessions.create({
    parentID: root.id,
    metadata: {
      subagent: {
        kind: "subagent", custom: false, agent: "general", title: "A bounded cancellation fixture",
        parentSessionID: root.id, parentMessageID: MessageID.ascending(),
        model: { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("fixture") },
        background: true, status: "running", startedAt: Date.now(),
        runtimeID: SubagentLifecycle.RUNTIME_ID, attempt: 1,
      },
    },
  })
  const running = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const waiting = yield* Deferred.make<void>()
  yield* jobs.start({
    id: child.id, type: "task",
    run: Deferred.succeed(running, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("verified")),
  })
  yield* awaitWithTimeout(Deferred.await(running), "fixture child never started")
  // Only publishes readiness; the real manager still owns selection and waiting.
  const info = yield* TaskManageTool.pipe(Effect.provide(Layer.mock(TaskManager.Service, {
    wait: (input) => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(manager.wait(input))),
  })))
  const tool = yield* Tool.init(info)
  const controller = new AbortController()
  const context: Tool.Context = {
    sessionID: root.id, messageID: MessageID.ascending(), agent: "build", abort: controller.signal,
    messages: [], metadata: () => Effect.void, ask: () => Effect.void,
  }
  const bridge = yield* EffectBridge.make()
  const invoke = () => bridge.promise(tool.execute({ action: "wait", task_ids: [child.id], timeout: 60000 }, context).pipe(Effect.exit))
  return { child, jobs, release, waiting, controller, invoke }
})

describe("task_manage wait AbortSignal bridge", () => {
  it.instance("already-aborted calls do not begin selecting or waiting on tasks", () => Effect.gen(function* () {
    const value = yield* fixture()
    value.controller.abort(new Error("already-aborted-wait"))
    const result = yield* awaitWithTimeout(Effect.promise(value.invoke), "already-aborted wait did not settle")
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("already-aborted-wait")
    expect(yield* Deferred.isDone(value.waiting)).toBe(false)
    expect((yield* value.jobs.get(value.child.id))?.status).toBe("running")
    yield* value.jobs.cancel(value.child.id)
  }))

  it.instance("mid-wait abort settles the actual promise bridge without cancelling child work", () => Effect.gen(function* () {
    const value = yield* fixture()
    const result = value.invoke()
    yield* awaitWithTimeout(Deferred.await(value.waiting), "task manager wait never began")
    value.controller.abort(new Error("stopped-wait"))
    const settled = yield* awaitWithTimeout(Effect.promise(() => result), "wait ignored its abort signal")
    expect(Exit.isFailure(settled)).toBe(true)
    if (Exit.isFailure(settled)) expect(Cause.pretty(settled.cause)).toContain("stopped-wait")
    expect((yield* value.jobs.get(value.child.id))?.status).toBe("running")
    yield* Deferred.succeed(value.release, undefined)
    expect((yield* value.jobs.wait({ id: value.child.id })).info?.status).toBe("completed")
  }))

  it.instance("normal job completion still returns its final task state", () => Effect.gen(function* () {
    const value = yield* fixture()
    const result = value.invoke()
    yield* awaitWithTimeout(Deferred.await(value.waiting), "task manager wait never began")
    yield* Deferred.succeed(value.release, undefined)
    const settled = yield* awaitWithTimeout(Effect.promise(() => result), "completed child did not wake its wait")
    expect(Exit.isSuccess(settled)).toBe(true)
    if (Exit.isSuccess(settled)) {
      const output = JSON.parse(settled.value.output)
      expect(output.timedOut).toBe(false)
      expect(output.tasks).toHaveLength(1)
      expect(output.tasks[0].status).toBe("completed")
    }
    expect(value.controller.signal.aborted).toBe(false)
  }))
})
