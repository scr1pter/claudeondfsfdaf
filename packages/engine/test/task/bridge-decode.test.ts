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
import { InstanceState } from "@/effect/instance-state"
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

  // F6: a stored record a newer engine wrote may name a cost kind this one does not know (a downgrade, or a stale
  // record left behind). It reads as "unknown" instead of marking the parent's whole desktop record damaged.
  it.instance("a stored task with a cost kind a newer version added reads as unknown", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const desktop = yield* DesktopTasks.Service
      const directory = yield* InstanceState.directory
      const parent = yield* sessions.create()
      const child = yield* sessions.create({ parentID: parent.id })
      const stored = (sessionID: string, id: string) => ({
        runtimeID: "another-runtime",
        directory,
        leaseHash: "lease",
        expiresAt: 0,
        commands: [],
        tasks: [
          {
            ...observation(sessionID),
            id,
            costKind: "future-kind",
            budgetScopes: [
              { kind: "run", id: "run-1", budget: {}, spentUsd: 0, steps: 1, unpricedSteps: 0, costKind: "future-kind" },
            ],
          },
        ],
      })
      yield* storage.write(["task-bridge", parent.id], stored(parent.id, "workspace:parent")).pipe(Effect.orDie)
      yield* storage.write(["task-bridge", child.id], stored(child.id, "workspace:child")).pipe(Effect.orDie)
      const own = (yield* desktop.list({ sessionID: parent.id })).tasks
      expect(own.map((task) => [task.id, task.costKind, task.budgetScopes?.[0]?.costKind])).toEqual([
        ["workspace:parent", "unknown", "unknown"],
      ])
      // The child's record, read with the parent's descendants, does not break the parent's listing either.
      const family = (yield* desktop.list({ sessionID: parent.id, descendants: true })).tasks
      expect(family.map((task) => [task.id, task.costKind])).toEqual([
        ["workspace:parent", "unknown"],
        ["workspace:child", "unknown"],
      ])
    }),
  )

  it.instance("a stored task whose cost kind is not a string still marks the record damaged", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const storage = yield* Storage.Service
      const desktop = yield* DesktopTasks.Service
      const parent = yield* sessions.create()
      yield* storage
        .write(["task-bridge", parent.id], {
          runtimeID: "another-runtime",
          directory: yield* InstanceState.directory,
          leaseHash: "lease",
          expiresAt: 0,
          commands: [],
          tasks: [{ ...observation(parent.id), costKind: 7 }],
        })
        .pipe(Effect.orDie)
      const exit = yield* desktop.list({ sessionID: parent.id }).pipe(Effect.flip)
      expect(exit.code).toBe("invalid")
    }),
  )
})
