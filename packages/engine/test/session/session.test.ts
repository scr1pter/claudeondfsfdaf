import { describe, expect } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { EventV2 } from "@vectordevai/core/event"
import { SessionEvent } from "@vectordevai/schema/session-event"
import { SessionMessage } from "@vectordevai/schema/session-message"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionArchive } from "@vectordevai/core/share/archive"
import { AbsolutePath } from "@vectordevai/core/schema"
import { DateTime, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2.node,
      SessionArchive.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "lmstudio", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("session cost totals", () => {
  it.instance("a session update read before a step settled does not erase that step's cost", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* session.create({ title: "cost totals" })
      // What setTitle or setMetadata read just before a step-finish landed: the totals as they were.
      const stale = yield* session.get(info.id)
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID: info.id,
        mode: "build",
        agent: "build",
        cost: 0.5,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test",
        providerID: "lmstudio",
        time: { created: Date.now() },
      } as unknown as SessionV1.Info)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID: info.id,
        type: "step-finish",
        reason: "stop",
        cost: 0.5,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      expect((yield* session.get(info.id)).cost).toBe(0.5)

      yield* events.publish(SessionV1.Event.Updated, { sessionID: info.id, info: { ...stale, title: "renamed" } })

      const after = yield* session.get(info.id)
      expect(after.title).toBe("renamed")
      expect(after.cost).toBe(0.5)
      expect(after.tokens?.input).toBe(100)
      yield* session.remove(info.id)
    }),
  )
})

describe("forked sessions", () => {
  it.instance("a fork copies the history without counting its spend twice", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "fork spend" })
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID: info.id,
        mode: "build",
        agent: "build",
        cost: 0.5,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test",
        providerID: "lmstudio",
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      } as unknown as SessionV1.Info)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID: info.id,
        type: "step-finish",
        reason: "stop",
        cost: 0.5,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const before = yield* session.usage()

      const fork = yield* session.fork({ sessionID: info.id })

      const after = yield* session.usage()
      expect(after.lifetimeCost).toBe(before.lifetimeCost)
      expect(after.lifetimeTokens).toBe(before.lifetimeTokens)
      expect(after.modelResponses).toBe(before.modelResponses)
      expect((yield* session.get(fork.id)).cost).toBe(0)
      expect((yield* session.get(info.id)).cost).toBe(0.5)
      // The copy keeps its tokens so the forked session still shows how much context it carries.
      const copied = (yield* session.messages({ sessionID: fork.id }))[0]?.info
      expect(copied).toMatchObject({ role: "assistant", cost: 0, forked: true, tokens: { input: 100, output: 20 } })
      yield* session.remove(fork.id)
      yield* session.remove(info.id)
    }),
  )
})

describe("forked Codium sessions", () => {
  it.instance("a fork copies Codium history without adding a Codium step, an unpriced step or tokens", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "codium fork" })
      const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
      const message = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID: info.id,
        mode: "build",
        agent: "build",
        cost: 0,
        unpriced: true,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens,
        modelID: "deepseek",
        providerID: "vector-plan",
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      } as unknown as SessionV1.Info)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: info.id,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        unpriced: true,
        billing: "codium",
        tokens,
      })

      const fork = yield* session.fork({ sessionID: info.id })

      const copy = yield* session.get(fork.id)
      expect(copy.cost).toBe(0)
      expect(copy.unpricedSteps).toBeUndefined()
      expect(copy.codiumSteps).toBeUndefined()
      expect(copy.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
      expect(yield* session.get(info.id)).toMatchObject({ unpricedSteps: 1, codiumSteps: 1 })
      // The cloned message keeps its flag, for display; its copied step carries none.
      const copied = (yield* session.messages({ sessionID: fork.id }))[0]
      expect(copied?.info).toMatchObject({ role: "assistant", billing: "codium", forked: true })
      expect(copied?.parts.find((part) => part.type === "step-finish")).not.toHaveProperty("billing", "codium")
      yield* session.remove(fork.id)
      yield* session.remove(info.id)
    }),
  )
})

describe("usage by directory", () => {
  it.instance("counts only the sessions in the directory asked for", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "usage scope" })
      yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID: info.id,
        mode: "build",
        agent: "build",
        cost: 0.5,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test",
        providerID: "lmstudio",
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      } as unknown as SessionV1.Info)

      const elsewhere = yield* session.usage({ directory: `${info.directory}-elsewhere` })
      expect(elsewhere.lifetimeCost).toBe(0)
      expect(elsewhere.lifetimeTokens).toBe(0)
      expect(elsewhere.modelResponses).toBe(0)
      const here = yield* session.usage({ directory: info.directory })
      expect(here.lifetimeCost).toBeCloseTo(0.5)
      expect(here.modelResponses).toBe(1)
      expect((yield* session.usage()).lifetimeCost).toBeGreaterThanOrEqual(here.lifetimeCost)
      yield* session.remove(info.id)
    }),
  )
})

describe("unpriced steps", () => {
  it.instance("a session counts steps that had no price and stops counting them when they are removed", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "unpriced steps" })
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID: info.id,
        mode: "build",
        agent: "build",
        cost: 0.25,
        unpriced: true,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test",
        providerID: "lmstudio",
        time: { created: Date.now() },
      } as unknown as SessionV1.Info)
      const step = (cost: number, unpriced: boolean) => ({
        id: PartID.ascending(),
        messageID,
        sessionID: info.id,
        type: "step-finish" as const,
        reason: "tool-calls",
        cost,
        ...(unpriced ? { unpriced: true } : {}),
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const priced = step(0.25, false)
      const unknown = step(0, true)
      yield* session.updatePart(priced)
      yield* session.updatePart(unknown)

      const counted = yield* session.get(info.id)
      expect(counted.cost).toBe(0.25)
      expect(counted.unpricedSteps).toBe(1)

      yield* session.removePart({ sessionID: info.id, messageID, partID: unknown.id })
      const after = yield* session.get(info.id)
      expect(after.cost).toBe(0.25)
      expect(after.unpricedSteps).toBeUndefined()
      yield* session.remove(info.id)
    }),
  )
})

describe("Codium steps", () => {
  const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
  const noTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const assistant = (sessionID: SessionID, providerID: string) =>
    ({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens,
      modelID: "deepseek",
      providerID,
      time: { created: Date.now() },
    }) as unknown as SessionV1.Assistant
  // A step-finish part as the processor writes one: a Codium step carries the flag Session.getUsage returned.
  const step = (message: SessionV1.Assistant, value: { cost: number; unpriced?: true; billing?: "codium" }) => ({
    id: PartID.ascending(),
    messageID: message.id,
    sessionID: message.sessionID,
    type: "step-finish" as const,
    reason: "stop",
    ...value,
    tokens,
  })
  const codium = { cost: 0, unpriced: true, billing: "codium" } as const

  it.instance("only assistant messages on Vector Codium are published with the flag", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "codium flag" })
      const onCodium = assistant(info.id, "vector-plan")
      const stamped = yield* session.updateMessage(onCodium)
      const own = yield* session.updateMessage(assistant(info.id, "lmstudio"))
      yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: info.id,
        agent: "build",
        model: { providerID: "vector-plan", modelID: "deepseek" },
        time: { created: Date.now() },
      } as unknown as SessionV1.Info)
      expect(stamped).toMatchObject({ billing: "codium" })
      // The published copy carries the flag; the caller's object is left as it was.
      expect(onCodium).not.toHaveProperty("billing")
      expect(own).not.toHaveProperty("billing")
      const stored = (yield* session.messages({ sessionID: info.id })).map((message) => message.info)
      expect(stored.map((message) => [message.role, "billing" in message ? message.billing : undefined])).toEqual([
        ["assistant", "codium"],
        ["assistant", undefined],
        ["user", undefined],
      ])
      yield* session.remove(info.id)
    }),
  )

  it.instance("a Codium step counts as one unpriced Codium step with no tokens until it is removed", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const info = yield* session.create({ title: "codium steps" })
      const stale = yield* session.get(info.id)
      const message = yield* session.updateMessage(assistant(info.id, "vector-plan"))
      const codiumStep = step(message, codium)
      yield* session.updatePart(codiumStep)
      expect(yield* session.get(info.id)).toMatchObject({ cost: 0, unpricedSteps: 1, codiumSteps: 1, tokens: noTokens })

      // An own step beside it counts as before, and a session update read before both steps erases neither.
      yield* session.updatePart(step(message, { cost: 0.25 }))
      yield* events.publish(SessionV1.Event.Updated, { sessionID: info.id, info: { ...stale, title: "renamed" } })
      expect(yield* session.get(info.id)).toMatchObject({
        title: "renamed",
        cost: 0.25,
        unpricedSteps: 1,
        codiumSteps: 1,
        tokens,
      })

      yield* session.removePart({ sessionID: info.id, messageID: message.id, partID: codiumStep.id })
      const removed = yield* session.get(info.id)
      expect(removed).toMatchObject({ cost: 0.25, tokens })
      expect(removed.unpricedSteps).toBeUndefined()
      expect(removed.codiumSteps).toBeUndefined()

      yield* session.updatePart(step(message, codium))
      expect((yield* session.get(info.id)).codiumSteps).toBe(1)
      yield* session.removeMessage({ sessionID: info.id, messageID: message.id })
      const cleared = yield* session.get(info.id)
      expect(cleared).toMatchObject({ cost: 0, tokens: noTokens })
      expect(cleared.unpricedSteps).toBeUndefined()
      expect(cleared.codiumSteps).toBeUndefined()
      yield* session.remove(info.id)
    }),
  )

  it.instance("a Codium step moved to another session takes its Codium count with it", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const from = yield* session.create({ title: "codium from" })
      const to = yield* session.create({ title: "codium to" })
      const message = yield* session.updateMessage(assistant(from.id, "vector-plan"))
      const moved = step(message, codium)
      yield* session.updatePart(moved)
      yield* session.updatePart({ ...moved, sessionID: to.id })
      const left = yield* session.get(from.id)
      expect(left.unpricedSteps).toBeUndefined()
      expect(left.codiumSteps).toBeUndefined()
      expect(yield* session.get(to.id)).toMatchObject({ unpricedSteps: 1, codiumSteps: 1, tokens: noTokens })
      yield* session.remove(from.id)
      yield* session.remove(to.id)
    }),
  )

  it.instance("a Codium step recorded before the flag is taken back as the ordinary step it was counted as", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "flagless codium" })
      const message = yield* session.updateMessage(assistant(info.id, "vector-plan"))
      // Written before A22: the message is on Vector Codium, but its step-finish parts carry no flag.
      const removed = step(message, { cost: 0, unpriced: true })
      yield* session.updatePart(removed)
      yield* session.updatePart(step(message, { cost: 0, unpriced: true }))
      expect(yield* session.get(info.id)).toMatchObject({
        unpricedSteps: 2,
        tokens: { input: 200, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      expect((yield* session.get(info.id)).codiumSteps).toBeUndefined()

      yield* session.removePart({ sessionID: info.id, messageID: message.id, partID: removed.id })
      expect(yield* session.get(info.id)).toMatchObject({ unpricedSteps: 1, tokens })
      yield* session.removeMessage({ sessionID: info.id, messageID: message.id })
      const after = yield* session.get(info.id)
      expect(after).toMatchObject({ tokens: noTokens })
      expect(after.unpricedSteps).toBeUndefined()
      // Never below 0: a negative count would fail the session's encoding on every read.
      expect(after.codiumSteps).toBeUndefined()
      yield* session.remove(info.id)
    }),
  )
})

describe("subagent spend", () => {
  it.instance("late descendant spend refreshes the root without inflating assistant activity or duration", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const events = yield* EventV2.Service
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: root.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })
      const messageID = MessageID.ascending()
      const started = Date.now() - 1000
      yield* sessions.updateMessage({
        id: messageID,
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID: root.id,
        mode: "build",
        agent: "build",
        cost: 0.1,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("main-model"),
        providerID: ProviderV2.ID.make("openai"),
        finish: "stop",
        time: { created: started, completed: started + 500 },
      })
      const before = yield* sessions.usage()
      const beforeRoot = yield* sessions.get(root.id)
      const late = Date.now() + 7 * 86_400_000
      yield* events.publish(SessionEvent.AncillaryUsage, {
        sessionID: grandchild.id,
        timestamp: DateTime.makeUnsafe(late),
        usageID: EventV2.ID.create(),
        purpose: "title",
        model: { id: ModelV2.ID.make("title-model"), providerID: ProviderV2.ID.make("openai") },
        cost: 0.05,
        tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const after = yield* sessions.usage()
      const afterRoot = yield* sessions.get(root.id)
      expect(afterRoot.time.updated).toBe(late)
      expect(afterRoot.time.created).toBe(beforeRoot.time.created)
      expect(afterRoot.subagentCost).toBeCloseTo(0.05)
      for (const key of ["longestTaskMs", "averageTaskMs", "currentStreak", "longestStreak"] as const)
        expect(after[key]).toBe(before[key])
      expect(after.lifetimeTokens).toBe(before.lifetimeTokens + 4)
      expect(after.favoriteModels).toEqual(before.favoriteModels)
      expect(after.days.filter((day) => day.tasks > 0)).toEqual(before.days.filter((day) => day.tasks > 0))
      expect(after.lifetimeCost).toBeCloseTo(before.lifetimeCost + 0.05)
      expect((yield* sessions.messages({ sessionID: root.id }))[0]?.info.time).toEqual({
        created: started,
        completed: started + 500,
      })
      yield* sessions.remove(root.id)
    }),
  )

  it.instance("a parent session carries what its subagents spent, apart from its own cost", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const parent = yield* session.create({ title: "parent" })
      const child = yield* session.create({ parentID: parent.id, title: "child" })
      const grandchild = yield* session.create({ parentID: child.id, title: "grandchild" })
      const spend = (sessionID: SessionID, cost: number) =>
        Effect.gen(function* () {
          const messageID = MessageID.ascending()
          yield* session.updateMessage({
            id: messageID,
            role: "assistant",
            parentID: MessageID.ascending(),
            sessionID,
            mode: "build",
            agent: "build",
            cost,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "anthropic",
            time: { created: Date.now() },
          } as unknown as SessionV1.Info)
          const part = {
            id: PartID.ascending(),
            messageID,
            sessionID,
            type: "step-finish" as const,
            reason: "stop",
            cost,
            tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          }
          yield* session.updatePart(part)
          return { messageID, partID: part.id, part }
        })
      yield* spend(parent.id, 0.6)
      const delegated = yield* spend(child.id, 2.4)

      expect(yield* session.get(parent.id)).toMatchObject({ cost: 0.6, subagentCost: 2.4 })
      expect((yield* session.get(child.id)).subagentCost).toBeUndefined()

      const firstRevision = (yield* session.get(parent.id)).time.updated
      yield* session.updatePart(delegated.part)
      expect((yield* session.get(parent.id)).time.updated).toBe(firstRevision)
      const childRevision = (yield* session.get(child.id)).time.updated
      yield* session.updatePart({ ...delegated.part, tokens: { ...delegated.part.tokens, input: 101 } })
      expect((yield* session.get(child.id)).time.updated).toBeGreaterThan(childRevision)
      // The parent's token rollup changed with it, so its revision moves too.
      const tokenRevision = (yield* session.get(parent.id)).time.updated
      expect(tokenRevision).toBeGreaterThan(firstRevision)
      expect((yield* session.get(parent.id)).subagentTokens?.input).toBe(101)
      const nested = yield* spend(grandchild.id, 0.25)
      const nestedRevision = (yield* session.get(parent.id)).time.updated
      expect(nestedRevision).toBeGreaterThan(tokenRevision)
      expect((yield* session.get(parent.id)).subagentCost).toBeCloseTo(2.65)
      expect((yield* session.get(child.id)).subagentCost).toBeCloseTo(0.25)
      yield* session.removePart({ sessionID: grandchild.id, messageID: nested.messageID, partID: nested.partID })
      expect((yield* session.get(parent.id)).time.updated).toBeGreaterThan(nestedRevision)

      // Removing the child's step takes it back out of the parent's rollup too.
      yield* session.removePart({ sessionID: child.id, messageID: delegated.messageID, partID: delegated.partID })
      expect((yield* session.get(parent.id)).subagentCost).toBeUndefined()
      yield* session.remove(grandchild.id)
      yield* session.remove(child.id)
      yield* session.remove(parent.id)
    }),
  )
})

describe("helper sessions", () => {
  const step = (sessionID: SessionID, cost: number, tokens: { input: number; output: number }) =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const messageID = MessageID.ascending()
      const usage = { ...tokens, reasoning: 0, cache: { read: 0, write: 0 } }
      yield* session.updateMessage({
        id: messageID,
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID,
        mode: "review",
        agent: "review",
        cost,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: usage,
        modelID: ModelV2.ID.make("review-model"),
        providerID: ProviderV2.ID.make("anthropic"),
        finish: "stop",
        time: { created: Date.now(), completed: Date.now() + 10 },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID,
        type: "step-finish",
        reason: "stop",
        cost,
        tokens: usage,
      })
    })

  it.instance("stay out of session lists and count their spend towards the session that launched them", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const launcher = yield* sessions.create({ title: "Fix the login flow" })
      const subagent = yield* sessions.create({ parentID: launcher.id, title: "explore (@explore subagent)" })
      // Parallel agents and team members are sessions the user started, linked to their task only in metadata.
      const parallel = yield* sessions.create({
        title: "Agent 2",
        metadata: { vector: { kind: "parallel-agent", workspaceId: "w2", parentSessionId: launcher.id } },
      })
      const review = yield* sessions.create({
        parentID: launcher.id,
        internal: "vectorscope.review",
        title: "Vectorscope review · uncommitted changes · review",
      })
      const standalone = yield* sessions.create({
        internal: "vectorscope.security",
        title: "Vectorscope review · #7 · security",
      })
      expect(review).toMatchObject({ internal: "vectorscope.review", parentID: launcher.id })

      const ids = (input?: SessionNs.ListInput) =>
        sessions.list({ limit: 50, ...input }).pipe(Effect.map((list) => list.map((session) => session.id)))
      expect((yield* ids({ roots: true })).toSorted()).toEqual([launcher.id, parallel.id].toSorted())
      expect((yield* ids()).toSorted()).toEqual([launcher.id, subagent.id, parallel.id].toSorted())
      expect((yield* ids({ internal: true })).toSorted()).toEqual(
        [launcher.id, subagent.id, parallel.id, review.id, standalone.id].toSorted(),
      )
      const global = (yield* sessions.listGlobal({ limit: 200 })).map((session) => session.id)
      expect(global).not.toContain(review.id)
      expect(global).not.toContain(standalone.id)
      expect((yield* sessions.listGlobal({ limit: 200, internal: true })).map((session) => session.id)).toContain(
        standalone.id,
      )
      // The launcher still reaches its helpers, which its cost breakdown names.
      expect((yield* sessions.children(launcher.id)).map((session) => session.id).toSorted()).toEqual(
        [subagent.id, review.id].toSorted(),
      )

      yield* step(launcher.id, 0.5, { input: 1_000, output: 200 })
      yield* step(subagent.id, 0.25, { input: 300, output: 50 })
      yield* step(review.id, 1.25, { input: 4_000, output: 600 })
      yield* step(standalone.id, 0.75, { input: 2_000, output: 100 })

      expect(yield* sessions.get(launcher.id)).toMatchObject({
        cost: 0.5,
        subagentCost: 1.5,
        tokens: { input: 1_000, output: 200 },
        subagentTokens: { input: 4_300, output: 650, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      // Usage keeps every dollar and token, counts only the user's own conversations, and names what helpers spent.
      const usage = yield* sessions.usage()
      expect(usage.lifetimeCost).toBeCloseTo(2.75)
      expect(usage.lifetimeTokens).toBe(1_200 + 350 + 4_600 + 2_100)
      expect(usage.conversations).toBe(2)
      expect(usage.days.reduce((total, day) => total + day.tasks, 0)).toBe(2)
      expect(usage.helpers).toEqual([
        { id: "vectorscope.review", sessions: 1, responses: 1, tokens: 4_600, cost: 1.25 },
        { id: "vectorscope.security", sessions: 1, responses: 1, tokens: 2_100, cost: 0.75 },
      ])

      yield* sessions.remove(standalone.id)
      yield* sessions.remove(parallel.id)
      yield* sessions.remove(launcher.id)
    }),
  )
})

describe("usage of V2 sessions", () => {
  it.instance("counts the steps of sessions run through the V2 prompt path, helpers included", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const events = yield* EventV2.Service
      const task = yield* sessions.create({ title: "Split the billing module" })
      const planner = yield* sessions.create({ parentID: task.id, internal: "swarm.planner", title: "Swarm planner" })
      const model = { id: ModelV2.ID.make("planner-model"), providerID: ProviderV2.ID.make("anthropic") }
      const assistantMessageID = SessionMessage.ID.make("msg_planner_step")
      yield* events.publish(SessionEvent.Prompted, {
        sessionID: planner.id,
        timestamp: DateTime.makeUnsafe(Date.now()),
        messageID: SessionMessage.ID.make("msg_planner_prompt"),
        prompt: { text: "Plan the work" },
        delivery: "steer",
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: planner.id,
        timestamp: DateTime.makeUnsafe(Date.now()),
        assistantMessageID,
        agent: "explore",
        model,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: planner.id,
        timestamp: DateTime.makeUnsafe(Date.now() + 5),
        assistantMessageID,
        finish: "stop",
        cost: 0.4,
        tokens: { input: 3_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      expect(yield* sessions.get(task.id)).toMatchObject({ subagentCost: 0.4 })
      const usage = yield* sessions.usage()
      expect(usage.lifetimeCost).toBeCloseTo(0.4)
      expect(usage.lifetimeTokens).toBe(3_500)
      expect(usage.favoriteModels).toEqual([
        { providerID: "anthropic", modelID: "planner-model", tokens: 3_500, responses: 1, percentage: 100 },
      ])
      expect(usage.conversations).toBe(0)
      expect(usage.helpers).toEqual([{ id: "swarm.planner", sessions: 1, responses: 1, tokens: 3_500, cost: 0.4 }])
      yield* sessions.remove(task.id)
    }),
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})

it.instance("forked history leaves ancillary title spend on the original session", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const events = yield* EventV2Bridge.Service
    const original = yield* sessions.create({ title: "Original" })
    yield* events.publish(SessionEvent.AncillaryUsage, {
      sessionID: original.id,
      timestamp: DateTime.nowUnsafe(),
      usageID: EventV2.ID.create(),
      purpose: "title",
      model: { id: ModelV2.ID.make("title"), providerID: ProviderV2.ID.make("test") },
      cost: 0.25,
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const forked = yield* sessions.fork({ sessionID: original.id })
    expect((yield* sessions.get(original.id)).cost).toBe(0.25)
    expect((yield* sessions.get(forked.id)).cost).toBe(0)
    expect(yield* sessions.messages({ sessionID: forked.id })).toHaveLength(0)
  }),
)

it.instance("global spend counts title attempts once through replay, archive imports, forks, and deletion", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    const events = yield* EventV2.Service
    const archives = yield* SessionArchive.Service
    const before = yield* sessions.usage()
    const original = yield* sessions.create({ title: "Usage provenance" })
    const first = yield* events.publish(SessionEvent.AncillaryUsage, {
      sessionID: original.id,
      timestamp: DateTime.nowUnsafe(),
      usageID: EventV2.ID.create(),
      purpose: "title",
      model: { id: ModelV2.ID.make("title"), providerID: ProviderV2.ID.make("test") },
      cost: 0.25,
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    yield* events.publish(SessionEvent.AncillaryUsage, {
      ...first.data,
      usageID: EventV2.ID.create(),
      cost: undefined,
      tokens: undefined,
      incomplete: true,
    })
    if (!first.durable) return yield* Effect.die("Ancillary usage was not durable")
    yield* events.replay({
      id: first.id,
      aggregateID: original.id,
      seq: first.durable.seq,
      type: EventV2.versionedType(first.type, first.durable.version),
      data: Schema.encodeSync(SessionEvent.AncillaryUsage.data)(first.data),
    })
    const recorded = yield* sessions.usage()
    expect(recorded.lifetimeCost).toBeCloseTo(before.lifetimeCost + 0.25)
    expect(recorded.unpricedResponses).toBe((before.unpricedResponses ?? 0) + 1)
    expect(recorded.lifetimeTokens).toBe(before.lifetimeTokens + 12)
    expect(recorded.inputTokens).toBe(before.inputTokens + 10)
    expect(recorded.outputTokens).toBe(before.outputTokens + 2)
    expect({
      ...recorded,
      lifetimeCost: before.lifetimeCost,
      lifetimeTokens: before.lifetimeTokens,
      inputTokens: before.inputTokens,
      outputTokens: before.outputTokens,
      peakTokens: before.peakTokens,
      unpricedResponses: before.unpricedResponses,
      days: before.days,
    }).toEqual({ ...before, unpricedResponses: before.unpricedResponses })

    const forked = yield* sessions.fork({ sessionID: original.id })
    const exported = yield* archives.export({ sessionID: original.id })
    const encoded =
      "engine" in exported
        ? Schema.encodeSync(SessionArchive.Native)(exported)
        : Schema.encodeSync(SessionArchive.Legacy)(exported)
    const location = { directory: AbsolutePath.make(original.directory) }
    const imported = yield* archives.import({ archive: encoded, location })
    const duplicate = yield* archives.import({ archive: encoded, location })
    expect(yield* sessions.usage()).toEqual(recorded)

    const conflicting = yield* archives.import({
      archive: {
        ...encoded,
        ancillaryUsage: encoded.ancillaryUsage?.map((usage) =>
          usage.usageID === first.data.usageID ? { ...usage, cost: 0.75 } : usage,
        ),
      },
      location,
    })
    const ambiguous = yield* sessions.usage()
    expect(ambiguous.lifetimeCost).toBe(before.lifetimeCost)
    expect(ambiguous.unpricedResponses).toBe((before.unpricedResponses ?? 0) + 2)
    yield* sessions.remove(conflicting.sessionID)
    expect(yield* sessions.usage()).toEqual(recorded)

    yield* sessions.remove(original.id)
    yield* sessions.remove(forked.id)
    yield* sessions.remove(imported.sessionID)
    expect(yield* sessions.usage()).toEqual(recorded)
    yield* sessions.remove(duplicate.sessionID)
    expect(yield* sessions.usage()).toEqual(before)
  }),
)
