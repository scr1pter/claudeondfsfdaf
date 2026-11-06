import { describe, expect, spyOn } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Database } from "@vectordevai/core/database/database"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { DateTime, Effect, Layer } from "effect"
import { EventV2 } from "@vectordevai/core/event"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionEvent } from "@vectordevai/schema/session-event"
import { aggregateSessionStats, displayStats } from "@/cli/cmd/stats"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      Database.node,
      EventV2.node,
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

const step = Effect.fn("StatsTest.step")(function* (
  sessionID: SessionID,
  created: number,
  cost: number,
  unpriced = false,
) {
  const session = yield* Session.Service
  const id = MessageID.ascending()
  const tokens = { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }
  yield* session.updateMessage({
    id,
    role: "assistant",
    parentID: MessageID.ascending(),
    sessionID,
    mode: "build",
    agent: "build",
    cost,
    ...(unpriced ? { unpriced: true } : {}),
    path: { cwd: "/tmp", root: "/tmp" },
    tokens,
    modelID: "test",
    providerID: "lmstudio",
    time: { created, completed: created },
  } as unknown as SessionV1.Info)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: id,
    sessionID,
    type: "step-finish",
    reason: "stop",
    cost,
    ...(unpriced ? { unpriced: true } : {}),
    tokens,
  })
})

const ancillary = Effect.fn("StatsTest.ancillary")(function* (
  sessionID: SessionID,
  created: number,
  cost: number,
  purpose: "title" | "memory" = "title",
) {
  const events = yield* EventV2.Service
  return yield* events.publish(SessionEvent.AncillaryUsage, {
    sessionID,
    timestamp: DateTime.makeUnsafe(created),
    usageID: EventV2.ID.create(),
    model: { providerID: ProviderV2.ID.make("stats-helper"), id: ModelV2.ID.make("stats-ancillary-test") },
    purpose,
    cost,
    tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 5, write: 7 } },
  })
})

describe("vector stats", () => {
  it.instance("a window counts only the spend made inside it, not the lifetime of a session touched in it", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const before = yield* aggregateSessionStats(7)
      const info = yield* session.create({ title: "long running" })
      yield* step(info.id, Date.now() - 60 * 24 * 60 * 60 * 1000, 40)
      yield* step(info.id, Date.now(), 0.1)

      const after = yield* aggregateSessionStats(7)
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.1)
      expect(after.totalTokens.input - before.totalTokens.input).toBe(1_000)
      expect((yield* session.get(info.id)).cost).toBeCloseTo(40.1)
      yield* session.remove(info.id)
    }),
  )

  it.instance("counts what Vector's helpers spent without counting them as sessions", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const before = yield* aggregateSessionStats(7)
      const task = yield* session.create({ title: "fix the login form" })
      const review = yield* session.create({
        title: "Vectorscope review · 1a2b3c4 · review",
        internal: "vectorscope.review",
        parentID: task.id,
      })
      const autocomplete = yield* session.create({ title: "Autocomplete", internal: "codespace.autocomplete" })
      yield* step(task.id, Date.now(), 0.5)
      yield* step(review.id, Date.now(), 0.25)
      yield* step(autocomplete.id, Date.now(), 0.01)

      const after = yield* aggregateSessionStats(7)
      expect(after.totalSessions - before.totalSessions).toBe(1)
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.76)
      expect(after.totalTokens.input - before.totalTokens.input).toBe(3_000)
      expect(after.helpers.cost - before.helpers.cost).toBeCloseTo(0.26)
      expect(after.helpers.tokens - before.helpers.tokens).toBe(2_200)
      // Only the task's reply is a message of the user's, and the average divides only the user's tokens.
      expect(after.totalMessages - before.totalMessages).toBe(1)
      const tokens = (stats: typeof after) =>
        stats.totalTokens.input +
        stats.totalTokens.output +
        stats.totalTokens.reasoning +
        stats.totalTokens.cache.read +
        stats.totalTokens.cache.write
      expect(after.tokensPerSession * after.totalSessions).toBeCloseTo(tokens(after) - after.helpers.tokens)
      yield* session.remove(autocomplete.id)
      yield* session.remove(task.id)
    }),
  )

  it.instance("a window leaves out a session that was only renamed inside it", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const before = yield* aggregateSessionStats(7)
      const info = yield* session.create({ title: "old work" })
      yield* step(info.id, Date.now() - 60 * 24 * 60 * 60 * 1000, 2)
      yield* session.setTitle({ sessionID: info.id, title: "renamed today" })

      const after = yield* aggregateSessionStats(7)
      expect(after.totalSessions).toBe(before.totalSessions)
      expect(after.totalCost).toBeCloseTo(before.totalCost)
      yield* session.remove(info.id)
    }),
  )

  it.instance("windowed statistics include dated title and memory usage without doubling lifetime totals", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const before = yield* aggregateSessionStats(7)
      const lifetime = yield* aggregateSessionStats()
      const info = yield* session.create({ title: "ancillary statistics" })
      const now = Date.now()
      const old = now - 60 * 24 * 60 * 60 * 1000
      yield* step(info.id, old, 40)
      yield* step(info.id, now, 0.1)
      yield* ancillary(info.id, old, 10)
      yield* ancillary(info.id, now, 0.02)
      yield* ancillary(info.id, now, 0.03, "memory")

      const after = yield* aggregateSessionStats(7)
      const allTime = yield* aggregateSessionStats()
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.15)
      expect(after.totalTokens.input - before.totalTokens.input).toBe(1_020)
      expect(after.totalTokens.output - before.totalTokens.output).toBe(104)
      expect(after.totalTokens.reasoning - before.totalTokens.reasoning).toBe(6)
      expect(after.totalTokens.cache.read - before.totalTokens.cache.read).toBe(10)
      expect(after.totalTokens.cache.write - before.totalTokens.cache.write).toBe(14)
      expect(after.helpers.cost - before.helpers.cost).toBeCloseTo(0.05)
      expect(after.helpers.tokens - before.helpers.tokens).toBe(54)
      expect(after.totalMessages - before.totalMessages).toBe(1)
      expect(after.totalSessions - before.totalSessions).toBe(1)
      expect(after.modelUsage["stats-helper/stats-ancillary-test"]).toMatchObject({
        messages: 2,
        cost: 0.05,
        tokens: { input: 20, output: 10, cache: { read: 10, write: 14 } },
      })
      expect(allTime.totalCost - lifetime.totalCost).toBeCloseTo(50.15)
      expect(allTime.totalTokens.input - lifetime.totalTokens.input).toBe(2_030)
      expect(allTime.helpers.cost - lifetime.helpers.cost).toBeCloseTo(10.05)
      expect((yield* session.get(info.id)).cost).toBeCloseTo(50.15)
      yield* session.remove(info.id)
    }),
  )

  it.instance("ancillary-only spend in a window does not create a conversation or message", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const before = yield* aggregateSessionStats(7)
      const info = yield* session.create({ title: "old work with a background helper" })
      yield* step(info.id, Date.now() - 60 * 24 * 60 * 60 * 1000, 2)
      yield* ancillary(info.id, Date.now(), 0.03, "memory")

      const after = yield* aggregateSessionStats(7)
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.03)
      expect(after.totalTokens.input - before.totalTokens.input).toBe(10)
      expect(after.helpers.cost - before.helpers.cost).toBeCloseTo(0.03)
      expect(after.totalMessages).toBe(before.totalMessages)
      expect(after.totalSessions).toBe(before.totalSessions)
      yield* session.remove(info.id)
    }),
  )

  it.instance("preserved paid-attempt IDs in imported receipts count once in windows and lifetime totals", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventV2.Service
      const before = yield* aggregateSessionStats(7)
      const lifetime = yield* aggregateSessionStats()
      const original = yield* session.create({ title: "original paid work" })
      const imported = yield* session.create({ title: "local archive copy" })
      yield* step(original.id, Date.now(), 0.1)
      const receipt = yield* ancillary(original.id, Date.now(), 0.02)
      // Archive import remaps session/event IDs but preserves the original usageID and bill.
      yield* events.publish(SessionEvent.AncillaryUsage, { ...receipt.data, sessionID: imported.id })
      expect((yield* session.get(imported.id)).cost).toBeCloseTo(0.02)

      const after = yield* aggregateSessionStats(7)
      const allTime = yield* aggregateSessionStats()
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.12)
      expect(allTime.totalCost - lifetime.totalCost).toBeCloseTo(0.12)
      expect(after.totalTokens.input - before.totalTokens.input).toBe(1_010)
      expect(allTime.totalTokens.input - lifetime.totalTokens.input).toBe(1_010)
      expect(after.helpers.cost - before.helpers.cost).toBeCloseTo(0.02)
      expect(allTime.helpers.tokens - lifetime.helpers.tokens).toBe(27)
      expect(after.modelUsage["stats-helper/stats-ancillary-test"]).toMatchObject({ messages: 1, cost: 0.02 })
      yield* session.remove(imported.id)
      yield* session.remove(original.id)
    }),
  )

  it.instance("conflicting imported copies count as one unknown attempt without choosing a bill", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventV2.Service
      const before = yield* aggregateSessionStats(7)
      const lifetime = yield* aggregateSessionStats()
      const original = yield* session.create({ title: "conflicting original" })
      const imported = yield* session.create({ title: "conflicting copy" })
      yield* step(original.id, Date.now(), 0.1)
      const receipt = yield* ancillary(original.id, Date.now(), 0.02)
      yield* events.publish(SessionEvent.AncillaryUsage, { ...receipt.data, sessionID: imported.id, cost: 0.03 })

      const after = yield* aggregateSessionStats(7)
      const allTime = yield* aggregateSessionStats()
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.1)
      expect(allTime.totalCost - lifetime.totalCost).toBeCloseTo(0.1)
      expect(after.helpers.cost).toBeCloseTo(before.helpers.cost)
      expect(after.unpricedSteps - before.unpricedSteps).toBe(1)
      expect(allTime.unpricedSteps - lifetime.unpricedSteps).toBe(1)
      expect(after.modelUsage["stats-helper/stats-ancillary-test"]).toBeUndefined()
      yield* session.remove(imported.id)
      yield* session.remove(original.id)
    }),
  )

  it.instance("missing and incomplete helper usage retain known charges and an unknown-cost warning", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventV2.Service
      const before = yield* aggregateSessionStats(7)
      const lifetime = yield* aggregateSessionStats()
      const info = yield* session.create({ title: "uncertain usage" })
      yield* step(info.id, Date.now(), 0, true)
      yield* events.publish(SessionEvent.AncillaryUsage, {
        sessionID: info.id,
        timestamp: DateTime.makeUnsafe(Date.now()),
        usageID: EventV2.ID.create(),
        model: { providerID: ProviderV2.ID.make("stats-helper"), id: ModelV2.ID.make("stats-ancillary-test") },
        purpose: "title",
        unpriced: true,
      })
      yield* events.publish(SessionEvent.AncillaryUsage, {
        sessionID: info.id,
        timestamp: DateTime.makeUnsafe(Date.now()),
        usageID: EventV2.ID.create(),
        model: { providerID: ProviderV2.ID.make("stats-helper"), id: ModelV2.ID.make("stats-ancillary-test") },
        purpose: "memory",
        cost: 0.03,
        incomplete: true,
        unpriced: true,
      })

      const after = yield* aggregateSessionStats(7)
      const allTime = yield* aggregateSessionStats()
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.03)
      expect(allTime.totalCost - lifetime.totalCost).toBeCloseTo(0.03)
      expect(after.unpricedSteps - before.unpricedSteps).toBe(3)
      expect(allTime.unpricedSteps - lifetime.unpricedSteps).toBe(3)
      const printed = spyOn(console, "log").mockImplementation(() => undefined)
      try {
        displayStats(after)
        const output = printed.mock.calls.flat().join("\n")
        expect(output).toContain("Recorded Cost")
        expect(output).toContain("+ unknown")
        expect(output).toContain("Unpriced/incomplete requests")
      } finally {
        printed.mockRestore()
      }
      yield* session.remove(info.id)
    }),
  )
})
