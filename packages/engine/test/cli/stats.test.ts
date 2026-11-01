import { describe, expect, spyOn } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Database } from "@vectordevai/core/database/database"
import { SessionMessageTable } from "@vectordevai/core/session/sql"
import { SessionMessage } from "@vectordevai/schema/session-message"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
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
    tokens,
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
