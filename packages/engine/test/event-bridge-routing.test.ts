import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Watcher } from "@vectordevai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { TaskPlace } from "@/task/place"
import { tmpdirScoped } from "./fixture/fixture"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([EventV2Bridge.node, Session.node, SessionProjector.node, CrossSpawnSpawner.node]),
  ),
)

it.instance("routes session deltas and a descendant's first event home while watcher events retain work", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const home = yield* InstanceState.context
    const directory = yield* tmpdirScoped()
    const root = yield* sessions.create()
    const child = yield* sessions.create({ parentID: root.id })
    TaskPlace.set(child.id, { home, work: { ...home, directory, worktree: directory } })
    const seen: Array<{ type: string; directory?: string; sessionID?: string }> = []
    const off = yield* events.listen((event) =>
      Effect.sync(
        () =>
          void seen.push({
            type: event.type,
            directory: event.location?.directory,
            sessionID:
              typeof event.data === "object" &&
              event.data &&
              "sessionID" in event.data &&
              typeof event.data.sessionID === "string"
                ? event.data.sessionID
                : undefined,
          }),
      ),
    )
    yield* Effect.addFinalizer(() => off)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        TaskPlace.drop(root.id)
        TaskPlace.drop(child.id)
      }),
    )
    yield* TaskPlace.within(child.id)(
      events.publish(SessionV1.Event.PartDelta, {
        sessionID: child.id,
        messageID: MessageID.ascending(),
        partID: PartID.ascending(),
        field: "text",
        delta: "working",
      }),
    )
    yield* TaskPlace.within(child.id)(
      events.publish(Watcher.Event.Updated, { file: path.join(directory, "code.ts"), event: "change" }),
    )
    const grandchild = yield* TaskPlace.within(child.id)(sessions.create({ parentID: child.id }))
    yield* Effect.addFinalizer(() => Effect.sync(() => TaskPlace.drop(grandchild.id)))
    expect(grandchild.directory).toBe(home.directory)
    expect(seen).toContainEqual({ type: SessionV1.Event.PartDelta.type, sessionID: child.id, directory: home.directory })
    expect(seen).toContainEqual({ type: Watcher.Event.Updated.type, sessionID: undefined, directory })
    expect(seen).toContainEqual({
      type: Session.Event.Created.type,
      sessionID: grandchild.id,
      directory: home.directory,
    })
  }),
)
