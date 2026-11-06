import { eq } from "drizzle-orm"
import { describe, expect, spyOn } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Database } from "@vectordevai/core/database/database"
import { SessionTable, SessionMessageTable } from "@vectordevai/core/session/sql"
import { SessionMessage } from "@vectordevai/schema/session-message"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { DateTime, Effect, Layer, Schema } from "effect"
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
  providerID = "lmstudio",
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
    providerID,
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
      yield* step(info.id, Date.now(), 0, "lmstudio", true)
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

for (const days of [undefined, 7]) {
  it.instance(`Codium V1 and helper figures stay out of ${days ? "window" : "lifetime"} own statistics`, () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const before = yield* aggregateSessionStats(days)
      const info = yield* session.create({ title: "mixed Codium usage" })
      const helper = yield* session.create({
        title: "Codium helper",
        internal: "vectorscope.review",
        parentID: info.id,
      })
      yield* step(info.id, Date.now(), 0.12)
      yield* step(info.id, Date.now(), 999, "vector-plan")
      yield* step(helper.id, Date.now(), 999, "vector-plan")
      const after = yield* aggregateSessionStats(days)
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.12)
      expect(after.totalTokens.input - before.totalTokens.input).toBe(1000)
      expect(after.totalTokens.output - before.totalTokens.output).toBe(100)
      expect(after.codiumResponses - before.codiumResponses).toBe(2)
      expect(after.helpers.tokens - before.helpers.tokens).toBe(0)
      expect(after.helpers.codiumResponses - before.helpers.codiumResponses).toBe(1)
      expect(after.modelUsage["vector-plan/test"]).toMatchObject({
        billing: "codium",
        cost: 0,
        tokens: { input: 0, output: 0 },
      })
      yield* session.remove(info.id)
    }),
  )
}

for (const days of [undefined, 7]) {
  it.instance(
    `a Codium helper receipt counts once as Codium in ${days ? "window" : "lifetime"} statistics, never as tokens, dollars or unknown cost`,
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const events = yield* EventV2.Service
        const before = yield* aggregateSessionStats(days)
        const info = yield* session.create({ title: "Codium title" })
        yield* step(info.id, Date.now(), 0.1)
        yield* events.publish(SessionEvent.AncillaryUsage, {
          sessionID: info.id,
          timestamp: DateTime.makeUnsafe(Date.now()),
          usageID: EventV2.ID.create(),
          model: { providerID: ProviderV2.ID.make("vector-plan"), id: ModelV2.ID.make("codium-title") },
          purpose: "title",
          cost: 0,
          unpriced: true,
          billing: "codium",
          tokens: { input: 24_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        const after = yield* aggregateSessionStats(days)
        expect(after.totalCost - before.totalCost).toBeCloseTo(0.1)
        expect(after.totalTokens.input - before.totalTokens.input).toBe(1_000)
        expect(after.helpers.cost - before.helpers.cost).toBeCloseTo(0)
        expect(after.helpers.tokens - before.helpers.tokens).toBe(0)
        expect(after.unpricedSteps - before.unpricedSteps).toBe(0)
        expect(after.codiumResponses - before.codiumResponses).toBe(1)
        expect(after.helpers.codiumResponses - before.helpers.codiumResponses).toBe(1)
        expect(after.modelUsage["vector-plan/codium-title"]).toMatchObject({
          billing: "codium",
          messages: 1,
          cost: 0,
          tokens: { input: 0, output: 0 },
        })
        yield* session.remove(info.id)
      }),
  )
}

it.instance("V2 stored billing and Codium compaction are omitted from printed own figures", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const database = yield* Database.Service
    const info = yield* session.create({ title: "V2 Codium" })
    const now = Date.now()
    for (const [seq, type] of ["assistant", "compaction"].entries()) {
      const message = Schema.encodeSync(SessionMessage.Message)(
        Schema.decodeUnknownSync(SessionMessage.Message)({
          id: `msg_stats_codium_${seq}`,
          type,
          time: { created: now },
          billing: "codium",
          cost: 999,
          tokens: { input: 24000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          ...(type === "assistant"
            ? { agent: "build", model: { providerID: "test", id: "test" }, content: [] }
            : { reason: "auto", summary: "summary", recent: "recent" }),
        }),
      )
      const { id, type: messageType, ...data } = message
      yield* database.db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: info.id,
          type: messageType,
          seq,
          time_created: now,
          time_updated: now,
          data,
        })
        .run()
        .pipe(Effect.orDie)
    }
    for (const days of [undefined, 7]) {
      const stats = yield* aggregateSessionStats(days)
      expect(stats.codiumResponses).toBe(2)
      expect(stats.totalCost).toBe(0)
      expect(stats.totalTokens.input).toBe(0)
      const lines: string[] = []
      const log = spyOn(console, "log").mockImplementation((...items) => {
        lines.push(items.join(" "))
      })
      try {
        displayStats(stats)
      } finally {
        log.mockRestore()
      }
      expect(lines.join("\n")).toContain('Vector Codium usage: see "vector codium".')
      expect(lines.join("\n")).not.toContain("$0.00")
      expect(lines.join("\n")).not.toContain("24000")
    }
    yield* session.remove(info.id)
  }),
)

it.instance(
  "unknown historical totals retain own dollars without exposing flagless compaction or empty-provider tokens",
  () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const before = yield* aggregateSessionStats()
      const info = yield* session.create({ title: "history missing" })
      yield* db
        .update(SessionTable)
        .set({
          tokens_own_only: false,
          tokens_input: 987654,
          cost: 0.12,
          codium_steps: 1,
          model: { id: "own", providerID: "own" },
        })
        .where(eq(SessionTable.id, info.id))
        .run()
        .pipe(Effect.orDie)
      const message = Schema.encodeSync(SessionMessage.Message)(
        Schema.decodeUnknownSync(SessionMessage.Message)({
          id: "msg_missing_compaction",
          type: "compaction",
          time: { created: Date.now() },
          reason: "auto",
          summary: "summary",
          recent: "recent",
          cost: 0,
          tokens: { input: 876543, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      )
      const { id, type, ...data } = message
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: info.id,
          type,
          seq: 0,
          time_created: Date.now(),
          time_updated: Date.now(),
          data,
        })
        .run()
        .pipe(Effect.orDie)
      const after = yield* aggregateSessionStats()
      expect(after.totalCost - before.totalCost).toBeCloseTo(0.12)
      expect(after.totalTokens.input - before.totalTokens.input).toBe(0)
      expect(after.codiumResponses - before.codiumResponses).toBe(1)
      yield* session.remove(info.id)
      const empty = yield* session.create({ title: "blank provider" })
      yield* step(empty.id, Date.now(), 0.12, "  ")
      const stats = yield* aggregateSessionStats()
      expect(stats.modelUsage["  /test"]).toBeUndefined()
      expect(stats.totalTokens.input - before.totalTokens.input).toBe(0)
      expect(stats.totalCost - before.totalCost).toBeCloseTo(0.12)
      yield* session.remove(empty.id)
    }),
)

for (const days of [undefined, 7]) {
  it.instance(
    `a V2 compaction summary without Codium counts in ${days ? "window" : "lifetime"} own cost and tokens, as on main`,
    () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { db } = yield* Database.Service
        const before = yield* aggregateSessionStats(days)
        const info = yield* session.create({ title: "V2 compaction" })
        // What the projector leaves for a priced compaction summary: its cost and tokens, and no own-only proof.
        yield* db
          .update(SessionTable)
          .set({ cost: 0.05, tokens_input: 3_000, tokens_output: 200, tokens_own_only: false })
          .where(eq(SessionTable.id, info.id))
          .run()
          .pipe(Effect.orDie)
        const message = Schema.encodeSync(SessionMessage.Message)(
          Schema.decodeUnknownSync(SessionMessage.Message)({
            id: "msg_stats_own_compaction",
            type: "compaction",
            time: { created: Date.now() },
            reason: "auto",
            summary: "summary",
            recent: "recent",
            cost: 0.05,
            tokens: { input: 3_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
        )
        const { id, type, ...data } = message
        yield* db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make(id),
            session_id: info.id,
            type,
            seq: 0,
            time_created: Date.now(),
            time_updated: Date.now(),
            data,
          })
          .run()
          .pipe(Effect.orDie)
        const after = yield* aggregateSessionStats(days)
        expect(after.totalCost - before.totalCost).toBeCloseTo(0.05)
        expect(after.totalTokens.input - before.totalTokens.input).toBe(3_000)
        expect(after.totalTokens.output - before.totalTokens.output).toBe(200)
        expect(after.unpricedSteps - before.unpricedSteps).toBe(0)
        expect(after.codiumResponses - before.codiumResponses).toBe(0)
        yield* session.remove(info.id)
      }),
  )
}

it.instance("lifetime statistics show 1.99.112 Codium history as Codium, not as unpriced requests", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const before = yield* aggregateSessionStats()
    const info = yield* session.create({ title: "Codium on 1.99.112" })
    // 1.99.112 stamped no Codium flag: each Codium step and its Codium title were recorded unpriced.
    yield* step(info.id, Date.now(), 0, "vector-plan", true)
    yield* step(info.id, Date.now(), 0, "vector-plan", true)
    yield* events.publish(SessionEvent.AncillaryUsage, {
      sessionID: info.id,
      timestamp: DateTime.makeUnsafe(Date.now()),
      usageID: EventV2.ID.create(),
      model: { providerID: ProviderV2.ID.make("vector-plan"), id: ModelV2.ID.make("codium-title") },
      purpose: "title",
      cost: 0,
      unpriced: true,
      tokens: { input: 500, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    // ...and counted all three as ordinary unpriced steps, with no Codium step.
    yield* db
      .update(SessionTable)
      .set({ unpriced_steps: 3, codium_steps: 0 })
      .where(eq(SessionTable.id, info.id))
      .run()
      .pipe(Effect.orDie)
    const after = yield* aggregateSessionStats()
    expect(after.unpricedSteps - before.unpricedSteps).toBe(0)
    expect(after.codiumResponses - before.codiumResponses).toBe(3)
    expect(after.totalCost - before.totalCost).toBeCloseTo(0)
    expect(after.totalTokens.input - before.totalTokens.input).toBe(0)
    const lines: string[] = []
    const log = spyOn(console, "log").mockImplementation((...items) => {
      lines.push(items.join(" "))
    })
    try {
      displayStats(after)
    } finally {
      log.mockRestore()
    }
    const output = lines.join("\n")
    expect(output).not.toContain("Unpriced/incomplete requests")
    expect(output).not.toContain("+ unknown")
    expect(output).toMatch(/Uncached Input\s+Codium/)
    yield* session.remove(info.id)
  }),
)
