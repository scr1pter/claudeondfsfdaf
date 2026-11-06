import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { TaskBridge } from "@vectordevai/schema/task-bridge"
import { DesktopTasks } from "@/task/desktop"
import { TaskManager } from "@/task/manager"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Multi-agent contract I29: a desktop's task bridge may send nested values this engine does not know yet. They are
// strings in the schema, so the payload decodes and the board keeps them instead of dropping the desktop's tasks.

afterEach(disposeAllInstances)
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      TaskManager.node,
      DesktopTasks.node,
      Session.node,
      Storage.node,
      BackgroundJob.node,
      EventV2Bridge.node,
    ]),
  ),
)

const observation = (parentSessionID: string) => ({
  id: "workspace:review",
  parentSessionID,
  source: "team",
  title: "Review parser",
  status: "running",
  startedAt: Date.now(),
  elapsedMs: 0,
  ownedPaths: ["parser.ts"],
  dependsOn: [],
  resultAvailable: false,
  attempt: 1,
  controls: { inspect: true, message: true, stop: true, review: true },
  isolation: { mode: "worktree", state: "rebasing", branch: "vector/review" },
  waiting: { kind: "review", since: 1_700_000_000_000, summary: "approve the plan" },
})

describe("desktop bridge payloads", () => {
  test("an unknown isolation.state and waiting.kind decode", () => {
    const input = Schema.decodeUnknownSync(TaskBridge.RegisterInput)({ tasks: [observation("ses_parent")] })
    expect(input.tasks[0]?.isolation?.state).toBe("rebasing")
    expect(input.tasks[0]?.waiting?.kind).toBe("review")
  })

  it.instance("a registered task with unknown nested values stays on the board", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const desktop = yield* DesktopTasks.Service
      const manager = yield* TaskManager.Service
      const parent = yield* sessions.create()
      const input = Schema.decodeUnknownSync(TaskBridge.RegisterInput)({ tasks: [observation(parent.id)] })
      yield* desktop.register({ sessionID: parent.id, ...input })
      const task = (yield* manager.list({ sessionID: parent.id })).tasks.find((item) => item.id === "workspace:review")
      expect(task?.isolation).toEqual({ mode: "worktree", state: "rebasing", branch: "vector/review" })
      expect(task?.waiting?.kind).toBe("review")
    }),
  )
})
