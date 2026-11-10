import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { InstanceRef } from "@/effect/instance-ref"
import { Session } from "@/session/session"
import { SessionCleanup } from "@/session/cleanup"
import { TaskPlace } from "@/task/place"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Session.node, SessionProjector.node, CrossSpawnSpawner.node])),
)

it.instance("runs cleanup once for each descendant while its row exists and unregisters hooks", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create()
    const child = yield* sessions.create({ parentID: root.id })
    const grandchild = yield* sessions.create({ parentID: child.id })
    const seen: string[] = []
    const unregister = SessionCleanup.register((info) =>
      sessions.get(info.id).pipe(
        Effect.map((row) => {
          seen.push(row.id)
        }),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.sync(unregister))
    yield* sessions.remove(root.id)
    expect(seen).toEqual([grandchild.id, child.id, root.id])
    expect(TaskPlace.parentOf(child.id)).toBeUndefined()
    expect(TaskPlace.parentOf(grandchild.id)).toBeUndefined()
    unregister()
    const other = yield* sessions.create()
    yield* sessions.remove(other.id)
    expect(seen).toHaveLength(3)
  }),
)

it.instance("cleanup tolerates a failing hook and deletion without an ambient instance", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create()
    const seen: string[] = []
    const offFailure = SessionCleanup.register(() => Effect.fail(new Error("fixture cleanup failure")))
    const offSuccess = SessionCleanup.register((info) =>
      Effect.sync(() => {
        seen.push(info.id)
      }),
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        offFailure()
        offSuccess()
      }),
    )
    yield* sessions.remove(session.id).pipe(Effect.provideService(InstanceRef, undefined))
    expect(seen).toEqual([session.id])
    expect(
      yield* sessions.get(session.id).pipe(
        Effect.option,
        Effect.map((value) => value._tag),
      ),
    ).toBe("None")
  }),
)
