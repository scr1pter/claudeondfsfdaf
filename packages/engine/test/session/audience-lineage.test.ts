import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { MessageID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      SessionAudience.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

it.instance("children and parentless history forks are private before their first Created event", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const audience = yield* SessionAudience.Service
    const events = yield* EventV2Bridge.Service
    const root = yield* sessions.create({})
    yield* audience.fenceIsolation({ sessionID: root.id, actor: "owner" })
    const observed: boolean[] = []
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Created.type) return Effect.void
      const data = event.data as typeof Session.Event.Created.data.Type
      return audience.isPrivate(data.sessionID).pipe(
        Effect.tap((value) => Effect.sync(() => observed.push(value))),
        Effect.asVoid,
      )
    })
    yield* Effect.addFinalizer(() => off)
    const child = yield* sessions.create({ parentID: root.id })
    const fork = yield* sessions.fork({ sessionID: child.id })
    expect(fork.parentID).toBeUndefined()
    expect(yield* audience.isPrivate(fork.id)).toBe(true)
    yield* sessions.create({ parentID: fork.id })
    expect(observed).toEqual([true, true, true])
  }),
)

it.instance("deleting intermediate sessions cannot erase the family's private history boundary", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const audience = yield* SessionAudience.Service
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id })
    const grandchild = yield* sessions.create({ parentID: child.id })
    yield* audience.fenceIsolation({ sessionID: grandchild.id, actor: "owner" })
    yield* sessions.remove(child.id)
    expect(yield* audience.isPrivate(root.id)).toBe(true)
    expect(yield* audience.knows(child.id)).toBe(true)
    expect(yield* audience.knows(grandchild.id)).toBe(true)
    const fork = yield* sessions.fork({ sessionID: root.id })
    expect(yield* audience.isPrivate(fork.id)).toBe(true)
  }),
)

it.instance("an owner's parentless fork cannot launder a guest-bearing conversation into isolation", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const audience = yield* SessionAudience.Service
    const root = yield* sessions.create({})
    yield* audience.markGuest(root.id)
    const fork = yield* sessions.fork({ sessionID: root.id })
    expect(yield* audience.hasGuestInput(fork.id)).toBe(true)
    expect(yield* audience.canIsolate(fork.id, "owner")).toBe(false)
  }),
)

it.instance("ordinary guest task lifecycle updates never gain privacy from an undefined isolation field", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const audience = yield* SessionAudience.Service
    const root = yield* sessions.create({})
    yield* audience.markGuest(root.id)
    const child = yield* sessions.create({
      parentID: root.id,
      metadata: {
        subagent: {
          kind: "subagent",
          agent: "general",
          custom: false,
          title: "Shared task",
          parentSessionID: root.id,
          parentMessageID: MessageID.ascending(),
          model: { providerID: "fixture", modelID: "fixture" },
          background: false,
          status: "queued",
          startedAt: Date.now(),
        },
      },
    })
    yield* SubagentLifecycle.write(sessions, child.id, { status: "running" })
    expect(SubagentLifecycle.read(yield* sessions.get(child.id))?.status).toBe("running")
    expect(yield* audience.isPrivate(root.id)).toBe(false)
    expect(yield* audience.hasGuestInput(child.id)).toBe(true)
  }),
)
