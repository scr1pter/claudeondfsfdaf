import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { EventTable } from "@vectordevai/core/event/sql"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionAccounting } from "@vectordevai/core/session/accounting"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { EventV2Bridge } from "../src/event-v2-bridge"
import { GlobalBus, type GlobalEvent } from "../src/bus/global"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { InstanceBootstrap } from "../src/project/bootstrap"
import { InstanceStore } from "../src/project/instance-store"
import { Session } from "../src/session/session"
import { MessageID, PartID, type SessionID } from "../src/session/schema"
import { testEffect } from "./lib/effect"

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
      [InstanceBootstrap.node, Layer.mock(InstanceBootstrap.Service, { run: Effect.void })],
    ],
  ),
)

const Wire = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  properties: Schema.optional(Schema.Unknown),
  syncEvent: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      seq: Schema.Number,
      aggregateID: Schema.String,
      data: Schema.Unknown,
    }),
  ),
})

const capture = Effect.fn("test.captureAccountingBridge")(function* () {
  const messages: (typeof Wire.Type)[] = []
  const listener = (event: GlobalEvent) => {
    const payload: unknown = event.payload
    if (!payload || typeof payload !== "object" || !("type" in payload)) return
    if (payload.type !== "session.created" && payload.type !== "session.updated" && payload.type !== "sync") return
    messages.push(Schema.decodeUnknownSync(Wire)(structuredClone(payload)))
  }
  GlobalBus.on("event", listener)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      GlobalBus.off("event", listener)
    }),
  )
  return messages
})

const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

const step = Effect.fn("test.accountingBridgeStep")(function* (
  sessionID: SessionID,
  input: number,
  cost: number,
  billing?: "codium",
) {
  const sessions = yield* Session.Service
  const messageID = MessageID.ascending()
  yield* sessions.updateMessage(
    SessionV1.Assistant.make({
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make(billing ? "vector-plan" : "own-provider"),
      agent: "build",
      mode: "build",
      path: { cwd: "/project", root: "/project" },
      time: { created: 1, completed: 2 },
      cost,
      tokens: tokens(input),
      ...(billing ? { billing, unpriced: true } : {}),
    }),
  )
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "step-finish",
    reason: "stop",
    cost,
    tokens: tokens(input),
    ...(billing ? { billing, unpriced: true } : {}),
  })
})

describe("EventV2Bridge accounting snapshots", () => {
  it.instance("UI snapshots use committed local totals while synchronization preserves the stored event", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventV2Bridge.Service
      const { db } = yield* Database.Service
      const observed = yield* capture()
      const session = yield* sessions.create({ title: "Canonical source" })
      expect(session).toMatchObject({ tokensOwnOnly: true, subagentTokensOwnOnly: true })
      expect(observed.find((event) => event.type === "session.created")?.properties).toMatchObject({
        info: { id: session.id, tokensOwnOnly: true, subagentTokensOwnOnly: true, tokens: tokens(0), cost: 0 },
      })
      const child = yield* sessions.create({ title: "Delegated own work", parentID: session.id })
      yield* step(session.id, 200, 0.12)
      yield* step(session.id, 900, 0, "codium")
      yield* step(child.id, 40, 0.04)
      const info = {
        ...session,
        title: "A stale or forged snapshot",
        tokens: tokens(987654),
        subagentTokens: tokens(999999),
        cost: 123,
        subagentCost: 456,
        unpricedSteps: 12,
        codiumSteps: 34,
        subagentUnpricedSteps: 56,
        subagentCodiumSteps: 78,
        tokensOwnOnly: true,
        subagentTokensOwnOnly: true,
      }
      const before = structuredClone(info)
      const published = yield* events.publish(SessionV1.Event.Updated, { sessionID: session.id, info })
      const ui = observed.find((event) => event.id === published.id && event.type === "session.updated")
      const sync = observed.find((event) => event.type === "sync" && event.syncEvent?.id === published.id)?.syncEvent
      expect(ui?.properties).toMatchObject({
        info: {
          title: info.title,
          tokens: tokens(200),
          subagentTokens: tokens(40),
          cost: 0.12,
          subagentCost: 0.04,
          unpricedSteps: 1,
          codiumSteps: 1,
          subagentUnpricedSteps: 0,
          subagentCodiumSteps: 0,
          tokensOwnOnly: true,
          subagentTokensOwnOnly: true,
        },
      })
      expect(sync?.data).toMatchObject({
        info: { tokens: tokens(987654), subagentTokens: tokens(999999), cost: 123, subagentCost: 456 },
      })
      const stored = yield* db.select().from(EventTable).where(eq(EventTable.id, published.id)).get().pipe(Effect.orDie)
      if (!stored || !sync) throw new Error("Missing durable bridge output")
      expect(JSON.parse(JSON.stringify(sync))).toEqual({
        id: stored.id,
        type: stored.type,
        seq: stored.seq,
        aggregateID: stored.aggregate_id,
        data: stored.data,
      })
      expect(info).toEqual(before)
      expect(published.data.info).toEqual(before)

      yield* SessionAccounting.invalidate(db, session.id)
      const later = yield* events.publish(SessionV1.Event.Updated, { sessionID: session.id, info })
      expect(
        observed.find((event) => event.id === later.id && event.type === "session.updated")?.properties,
      ).toMatchObject({
        info: {
          tokens: tokens(200),
          subagentTokens: tokens(40),
          cost: 0.12,
          subagentCost: 0.04,
          tokensOwnOnly: false,
          subagentTokensOwnOnly: false,
        },
      })
      expect(
        observed.find((event) => event.type === "sync" && event.syncEvent?.id === later.id)?.syncEvent?.data,
      ).toMatchObject({
        info: { tokensOwnOnly: true, subagentTokensOwnOnly: true, tokens: tokens(987654) },
      })
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.id, published.id)).get().pipe(Effect.orDie),
      ).toEqual(stored)
    }),
  )

  it.instance("forked history returns unknown proof and subsequent UI updates cannot inherit its source proof", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const observed = yield* capture()
      const source = yield* sessions.create({ title: "Original work" })
      yield* step(source.id, 200, 0.12)
      yield* step(source.id, 900, 0, "codium")
      const forked = yield* sessions.fork({ sessionID: source.id })
      expect(forked).toMatchObject({ tokensOwnOnly: false, subagentTokensOwnOnly: false, cost: 0, tokens: tokens(0) })
      expect(yield* sessions.get(forked.id)).toMatchObject({ tokensOwnOnly: false, subagentTokensOwnOnly: false })
      expect(yield* sessions.get(source.id)).toMatchObject({
        tokensOwnOnly: true,
        subagentTokensOwnOnly: true,
        cost: 0.12,
        tokens: tokens(200),
        codiumSteps: 1,
      })
      const messages = yield* sessions.messages({ sessionID: forked.id })
      expect(
        messages.find((message) => message.info.role === "assistant" && message.info.providerID === "vector-plan")
          ?.info,
      ).toMatchObject({
        forked: true,
        billing: "codium",
        tokens: tokens(900),
      })
      yield* sessions.setTitle({ sessionID: forked.id, title: "Continued fork" })
      expect(observed.filter((event) => event.type === "session.updated").at(-1)?.properties).toMatchObject({
        info: { id: forked.id, tokensOwnOnly: false, subagentTokensOwnOnly: false, cost: 0, tokens: tokens(0) },
      })
    }),
  )
})
