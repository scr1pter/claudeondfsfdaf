import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Location } from "../src/location"
import { ModelV2 } from "../src/model"
import { ProjectV2 } from "../src/project"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionAccounting } from "../src/session/accounting"
import { SessionAccountingOutput } from "../src/session/accounting-output"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionTable, SessionMessageTable } from "../src/session/sql"
import { SessionArchive } from "../src/share/archive"
import { SessionV1 } from "../src/v1/session"
import { testEffect } from "./lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const own = { id: ModelV2.ID.make("own-model"), providerID: ProviderV2.ID.make("own-provider") }
const codium = { id: ModelV2.ID.make("codium-model"), providerID: ProviderV2.ID.make("vector-plan") }
const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([SessionV2.node, SessionArchive.node, SessionProjector.node, Database.node, EventV2.node]),
    [
      [SessionExecution.node, SessionExecution.noopLayer],
      [
        ProjectV2.node,
        Layer.succeed(ProjectV2.Service, {
          resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
          directories: () => Effect.succeed([]),
          commit: () => Effect.void,
        }),
      ],
    ],
  ),
)

const row = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  })

const generic = (id: SessionV2.ID, parentID?: SessionV2.ID) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const info = SessionV1.SessionInfo.make({
      id,
      parentID,
      projectID: ProjectV2.ID.global,
      slug: "legacy",
      title: "Legacy",
      directory: "/project",
      version: "999.999.999",
      time: { created: 0, updated: 0 },
      tokensOwnOnly: true,
      subagentTokensOwnOnly: true,
      metadata: { tokensOwnOnly: true, subagentTokensOwnOnly: true },
    })
    yield* events.publish(SessionV1.Event.Created, { sessionID: id, info })
    return info
  })

const settle = (sessionID: SessionV2.ID, model: typeof own, input: number, billing?: "codium") =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      model,
      agent: "build",
      timestamp: DateTime.makeUnsafe(1),
    })
    yield* events.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(2),
      finish: "stop",
      cost: model.providerID === own.providerID && input > 0 ? 0.12 : 0,
      unpriced: model.providerID === codium.providerID,
      ...(billing ? { billing } : {}),
      tokens: tokens(input),
    })
    return assistantMessageID
  })

describe("local session token provenance", () => {
  it.effect("public event snapshots use current local proof without changing serialized event bytes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const observed: { raw: EventV2.Payload; projected: EventV2.Payload; before: string }[] = []
      yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== SessionV1.Event.Created.type) return
          const before = JSON.stringify(event)
          const projected = yield* SessionAccountingOutput.project(db, event)
          observed.push({ raw: event, projected, before })
        }),
      )
      const fresh = yield* sessions.create({ location })
      const legacyID = SessionV2.ID.create()
      yield* generic(legacyID)
      expect(observed).toHaveLength(2)
      expect(observed[0]?.projected).toMatchObject({
        data: { info: { tokensOwnOnly: true, subagentTokensOwnOnly: true } },
      })
      expect(observed[1]?.raw).toMatchObject({ data: { info: { tokensOwnOnly: true, subagentTokensOwnOnly: true } } })
      expect(observed[1]?.projected).toMatchObject({
        data: { info: { tokensOwnOnly: false, subagentTokensOwnOnly: false } },
      })
      const before = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, legacyID))
        .all()
        .pipe(Effect.orDie)
      expect(before[0]?.data).toMatchObject({ info: { tokensOwnOnly: true, subagentTokensOwnOnly: true } })
      yield* SessionAccounting.invalidate(db, fresh.id)
      expect(yield* SessionAccountingOutput.project(db, observed[0]!.raw)).toMatchObject({
        data: { info: { tokensOwnOnly: false, subagentTokensOwnOnly: false } },
      })
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, legacyID)).all().pipe(Effect.orDie),
      ).toEqual(before)
      for (const event of observed) expect(JSON.stringify(event.raw)).toBe(event.before)
    }),
  )

  it.effect("a proven Updated snapshot uses canonical accounting and leaves serialized values untrusted", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      yield* settle(session.id, own, 200)
      const observed: EventV2.Payload[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionV1.Event.Updated.type) observed.push(event)
        }),
      )
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: session.id,
        info: {
          id: session.id,
          projectID: ProjectV2.ID.global,
          slug: "test",
          title: "Renamed",
          directory: "/project",
          version: "test",
          time: { created: 0, updated: 3 },
          tokens: tokens(987654),
          subagentTokens: tokens(999),
          cost: 123,
          unpricedSteps: 456,
          codiumSteps: 789,
          tokensOwnOnly: true,
          subagentTokensOwnOnly: true,
        },
      })
      const raw = observed[0]!
      const before = JSON.stringify(raw)
      const projected = yield* SessionAccountingOutput.project(db, raw)
      expect(projected).toMatchObject({
        data: {
          info: {
            title: "Renamed",
            tokens: tokens(200),
            subagentTokens: tokens(0),
            cost: 0.12,
            unpricedSteps: 0,
            codiumSteps: 0,
            tokensOwnOnly: true,
            subagentTokensOwnOnly: true,
          },
        },
      })
      expect(JSON.stringify(raw)).toBe(before)
      expect(raw).toMatchObject({ data: { info: { tokens: tokens(987654), cost: 123 } } })
      const remote = { type: raw.type, properties: raw.data }
      expect(SessionAccountingOutput.untrusted(remote)).toMatchObject({
        properties: { info: { tokensOwnOnly: false, subagentTokensOwnOnly: false } },
      })
      expect(remote.properties).toEqual(raw.data)
      const sync = { type: "sync", syncEvent: raw }
      expect(SessionAccountingOutput.untrusted(sync)).toBe(sync)
    }),
  )

  it.effect("Created and replayed Updated cannot change the accounting row identity", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const other = SessionV2.ID.create()
      const info = {
        id: other,
        projectID: ProjectV2.ID.global,
        slug: "test",
        title: "test",
        directory: "/project",
        version: "test",
        time: { created: 0, updated: 0 },
      }
      const created = yield* events
        .publish(SessionV1.Event.Created, { sessionID: SessionV2.ID.create(), info })
        .pipe(Effect.exit)
      expect(created._tag).toBe("Failure")
      const replay = yield* events
        .replay({
          id: EventV2.ID.create(),
          aggregateID: session.id,
          seq: 1,
          type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
          data: { sessionID: session.id, info },
        })
        .pipe(Effect.exit)
      expect(replay._tag).toBe("Failure")
      const projected: unknown[] = []
      const notified: unknown[] = []
      yield* events.project(SessionV1.Event.Updated, (event) =>
        Effect.sync(() => {
          projected.push(event)
        }),
      )
      yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionV1.Event.Updated.type) notified.push(event)
        }),
      )
      const before = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, session.id))
        .all()
        .pipe(Effect.orDie)
      const batch = yield* events
        .replayAll(
          [
            {
              id: EventV2.ID.create(),
              aggregateID: session.id,
              seq: 1,
              type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
              data: { sessionID: session.id, info: { ...info, id: session.id } },
            },
            {
              id: EventV2.ID.create(),
              aggregateID: session.id,
              seq: 2,
              type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
              data: { sessionID: session.id, info },
            },
          ],
          { publish: true },
        )
        .pipe(Effect.exit)
      expect(batch._tag).toBe("Failure")
      expect(projected).toHaveLength(0)
      expect(notified).toHaveLength(0)
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all().pipe(Effect.orDie),
      ).toEqual(before)
      expect(yield* row(other)).toBeUndefined()
      expect(yield* row(session.id)).toMatchObject({ tokens_own_only: true })
    }),
  )

  it.effect("ancillary usage needs positive provider attribution, including records with empty legacy IDs", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      for (const providerID of [own.providerID, codium.providerID, ProviderV2.ID.make("")]) {
        const session = yield* sessions.create({ location })
        yield* events.publish(SessionEvent.AncillaryUsage, {
          sessionID: session.id,
          usageID: EventV2.ID.create(),
          timestamp: DateTime.makeUnsafe(1),
          purpose: "title",
          model: { ...own, providerID },
          cost: 0,
          tokens: tokens(100),
        })
        expect(yield* row(session.id)).toMatchObject({
          tokens_own_only: providerID !== "",
          tokens_input: providerID === codium.providerID ? 0 : 100,
        })
      }
    }),
  )

  it.effect("fresh creation cannot certify a row another projection has already populated", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.project(SessionV1.Event.Created, (event) =>
        db
          .update(SessionTable)
          .set({ tokens_input: 123 })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      )
      expect(yield* sessions.create({ location })).toMatchObject({
        tokens: tokens(123),
        tokensOwnOnly: false,
        subagentTokensOwnOnly: false,
      })
    }),
  )

  it.effect("accepted own-provider replay into a proven child invalidates ancestors; ignored duplicates do not", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const root = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: root.id })
      yield* settle(child.id, own, 200)
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const stored = (yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, child.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).at(-1)!
      const serialized = {
        id: stored.id,
        type: stored.type,
        seq: stored.seq,
        aggregateID: stored.aggregate_id,
        data: stored.data,
      }
      yield* events.replay(serialized)
      expect(yield* row(child.id)).toMatchObject({
        tokens_input: 200,
        tokens_own_only: true,
        subagent_tokens_own_only: true,
      })
      expect(yield* row(root.id)).toMatchObject({ subagent_tokens_own_only: true })
      yield* events.replay({
        ...serialized,
        id: EventV2.ID.create(),
        seq: stored.seq + 1,
        data: { ...stored.data, cost: 0.24, tokens: tokens(300) },
      })
      expect(yield* row(child.id)).toMatchObject({
        tokens_input: 300,
        cost: 0.24,
        tokens_own_only: false,
        subagent_tokens_own_only: false,
      })
      expect(yield* row(root.id)).toMatchObject({
        subagent_tokens_input: 300,
        subagent_cost: 0.24,
        subagent_tokens_own_only: false,
        tokens_own_only: true,
      })
    }),
  )

  it.effect("trusted fresh creation certifies empty totals; existing unknown rows cannot be certified by retry", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const fresh = yield* sessions.create({ location })
      expect(fresh).toMatchObject({ tokensOwnOnly: true, subagentTokensOwnOnly: true })
      const legacyID = SessionV2.ID.create()
      yield* generic(legacyID)
      expect(yield* sessions.create({ id: legacyID, location })).toMatchObject({
        tokensOwnOnly: false,
        subagentTokensOwnOnly: false,
      })
      expect(yield* sessions.create({ id: fresh.id, location })).toEqual(fresh)
    }),
  )

  it.effect("serialized create/update flags, metadata and version cannot promote unknown accounting", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      yield* sessions.create({ location })
      const id = SessionV2.ID.create()
      const info = yield* generic(id)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: id,
        info: { ...info, title: "Renamed", tokensOwnOnly: true },
      })
      expect(yield* sessions.get(id)).toMatchObject({
        title: "Renamed",
        tokensOwnOnly: false,
        subagentTokensOwnOnly: false,
      })
      yield* settle(id, own, 200)
      expect(yield* row(id)).toMatchObject({ tokens_input: 200, cost: 0.12, tokens_own_only: false })
    }),
  )

  it.effect("modern own and flagged Codium work keep separate proof through updates and reverts", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const root = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: root.id })
      const ownID = yield* settle(child.id, own, 200)
      yield* settle(child.id, codium, 900, "codium")
      expect(yield* sessions.get(child.id)).toMatchObject({
        tokens: tokens(200),
        cost: 0.12,
        codiumSteps: 1,
        tokensOwnOnly: true,
        subagentTokensOwnOnly: true,
      })
      expect(yield* sessions.get(root.id)).toMatchObject({
        subagentTokens: tokens(200),
        subagentTokensOwnOnly: true,
        tokensOwnOnly: true,
      })
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: child.id,
        assistantMessageID: ownID,
        timestamp: DateTime.makeUnsafe(3),
        finish: "stop",
        cost: 0.24,
        tokens: tokens(300),
      })
      expect(yield* row(child.id)).toMatchObject({ tokens_input: 300, cost: 0.24, tokens_own_only: true })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID: child.id,
        messageID: ownID,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect(yield* row(child.id)).toMatchObject({ tokens_input: 300, codium_steps: 0, tokens_own_only: true })
      expect(yield* row(root.id)).toMatchObject({ subagent_tokens_input: 300, subagent_tokens_own_only: true })
    }),
  )

  it.effect("old flagless Codium mixed with modern work loses proof permanently, including every ancestor", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const root = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: root.id })
      const leaf = yield* sessions.create({ location, parentID: child.id })
      const boundary = yield* settle(leaf.id, own, 0)
      yield* settle(leaf.id, codium, 100)
      yield* settle(leaf.id, codium, 900, "codium")
      yield* settle(leaf.id, own, 200)
      expect(yield* row(leaf.id)).toMatchObject({
        tokens_input: 300,
        cost: 0.12,
        codium_steps: 1,
        tokens_own_only: false,
        subagent_tokens_own_only: true,
      })
      for (const id of [root.id, child.id])
        expect(yield* row(id)).toMatchObject({
          subagent_tokens_input: 300,
          subagent_cost: 0.12,
          tokens_own_only: true,
          subagent_tokens_own_only: false,
        })
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID: leaf.id,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(5),
      })
      expect(yield* row(leaf.id)).toMatchObject({ tokens_input: 0, cost: 0, codium_steps: 0, tokens_own_only: false })
      for (const id of [root.id, child.id])
        expect(yield* row(id)).toMatchObject({ subagent_tokens_input: 0, subagent_tokens_own_only: false })
    }),
  )

  it.effect("an unknown child invalidates delegated proof even for a zero usage delta", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const root = yield* sessions.create({ location })
      const childID = SessionV2.ID.create()
      yield* generic(childID, root.id)
      expect(yield* row(root.id)).toMatchObject({ subagent_tokens_own_only: true })
      yield* settle(childID, own, 0)
      expect(yield* row(root.id)).toMatchObject({
        subagent_tokens_input: 0,
        subagent_tokens_own_only: false,
        tokens_own_only: true,
      })
    }),
  )

  it.effect("legacy step parts require their actual message identity and keep unknown proof after removal", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location })
      const events = yield* EventV2.Service
      const append = (providerID: string, input: number, billing?: "codium") =>
        Effect.gen(function* () {
          const messageID = SessionV1.MessageID.ascending()
          const message = SessionV1.Assistant.make({
            id: messageID,
            sessionID: session.id,
            role: "assistant",
            parentID: SessionV1.MessageID.ascending(),
            modelID: ModelV2.ID.make("model"),
            providerID: ProviderV2.ID.make(providerID),
            mode: "build",
            agent: "build",
            path: { cwd: "/project", root: "/project" },
            time: { created: 1, completed: 2 },
            cost: 0,
            tokens: tokens(input),
            ...(billing ? { billing } : {}),
          })
          yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: session.id, info: message })
          const part = SessionV1.StepFinishPart.make({
            id: SessionV1.PartID.ascending(),
            sessionID: session.id,
            messageID,
            type: "step-finish",
            reason: "stop",
            cost: 0,
            tokens: tokens(input),
            ...(billing ? { billing } : {}),
          })
          yield* events.publish(SessionV1.Event.PartUpdated, { sessionID: session.id, time: 2, part })
          return { message, part }
        })
      const first = yield* append("own-provider", 200)
      yield* append("vector-plan", 900, "codium")
      expect(yield* row(session.id)).toMatchObject({ tokens_input: 200, codium_steps: 1, tokens_own_only: true })
      const legacy = yield* append("vector-plan", 100)
      expect(yield* row(session.id)).toMatchObject({ tokens_input: 300, tokens_own_only: false })
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: session.id,
        messageID: legacy.message.id,
        partID: legacy.part.id,
      })
      expect(yield* row(session.id)).toMatchObject({ tokens_input: 200, tokens_own_only: false })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: session.id,
        info: { ...first.message, tokens: tokens(200) },
      })
      expect(yield* row(session.id)).toMatchObject({ tokens_input: 200, tokens_own_only: false })
    }),
  )

  it.effect("copy markers and changed legacy message identity invalidate an already proven aggregate", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      for (const change of [
        { forked: true },
        { providerID: codium.providerID },
        { providerID: ProviderV2.ID.make("") },
        { providerID: ProviderV2.ID.make("  ") },
        { providerID: ProviderV2.ID.make(" vector-plan ") },
        { providerID: ProviderV2.ID.make(" own-provider ") },
      ]) {
        const session = yield* sessions.create({ location })
        const messageID = SessionV1.MessageID.ascending()
        const message = SessionV1.Assistant.make({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: SessionV1.MessageID.ascending(),
          modelID: ModelV2.ID.make("model"),
          providerID: own.providerID,
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          time: { created: 1 },
          cost: 0,
          tokens: tokens(100),
        })
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: session.id, info: message })
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: session.id,
          time: 2,
          part: SessionV1.StepFinishPart.make({
            id: SessionV1.PartID.ascending(),
            sessionID: session.id,
            messageID,
            type: "step-finish",
            reason: "stop",
            cost: 0,
            tokens: tokens(100),
          }),
        })
        expect(yield* row(session.id)).toMatchObject({ tokens_own_only: true })
        yield* events.publish(SessionV1.Event.MessageUpdated, {
          sessionID: session.id,
          info: { ...message, ...change },
        })
        expect(yield* row(session.id)).toMatchObject({ tokens_input: 100, tokens_own_only: false })
      }
    }),
  )

  it.effect("importing even an empty message into a proven session invalidates local and inherited proof", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const root = yield* sessions.create({ location })
      const child = yield* sessions.create({ location, parentID: root.id })
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.MessageImported, {
        sessionID: child.id,
        timestamp: DateTime.makeUnsafe(1),
        message: SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "",
          time: { created: DateTime.makeUnsafe(1) },
        }),
      })
      expect(yield* sessions.get(child.id)).toMatchObject({ tokensOwnOnly: false, subagentTokensOwnOnly: false })
      expect(yield* sessions.get(root.id)).toMatchObject({ tokensOwnOnly: true, subagentTokensOwnOnly: false })
    }),
  )

  it.effect("a missing compaction identity is unknown while flagged Codium compaction retains proof", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      for (const billing of [undefined, "codium"] as const) {
        const session = yield* sessions.create({ location })
        yield* events.publish(SessionEvent.Compaction.Ended, {
          sessionID: session.id,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(1),
          reason: "auto",
          text: "summary",
          recent: "recent",
          cost: 0,
          tokens: tokens(100),
          ...(billing ? { billing } : {}),
        })
        expect(yield* row(session.id)).toMatchObject({
          tokens_own_only: billing === "codium",
          tokens_input: billing ? 0 : 100,
        })
      }
    }),
  )

  it.effect("deleted history and a later own contribution do not certify an unknown aggregate", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location })
      yield* settle(session.id, codium, 100)
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, session.id))
        .run()
        .pipe(Effect.orDie)
      yield* events.remove(session.id)
      yield* settle(session.id, own, 200)
      expect(yield* row(session.id)).toMatchObject({ tokens_input: 300, cost: 0.12, tokens_own_only: false })
      expect(yield* sessions.create({ id: session.id, location })).toMatchObject({ tokensOwnOnly: false })
    }),
  )

  it.effect("replaying an originally trusted Created event never replays its local promotion callback", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location })
      yield* settle(session.id, own, 200)
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const stored = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, session.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
      yield* events.remove(session.id)
      yield* events.replayAll(
        stored.map((event) => ({
          id: event.id,
          type: event.type,
          seq: event.seq,
          aggregateID: event.aggregate_id,
          data:
            event.type === EventV2.versionedType(SessionV1.Event.Created.type, 1)
              ? {
                  ...event.data,
                  info: {
                    ...(event.data.info as Record<string, unknown>),
                    tokensOwnOnly: true,
                    subagentTokensOwnOnly: true,
                  },
                }
              : event.data,
        })),
      )
      expect(yield* sessions.get(session.id)).toMatchObject({
        tokens: tokens(200),
        cost: 0.12,
        tokensOwnOnly: false,
        subagentTokensOwnOnly: false,
      })
    }),
  )

  it.effect("both native and legacy archive imports reject carried or tampered proof before notifying listeners", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location })
      const archives = yield* SessionArchive.Service
      const events = yield* EventV2.Service
      const observed: unknown[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionV1.Event.Created.type) observed.push(event.data)
        }),
      )
      for (const engine of ["v1", "v2"] as const) {
        const exported = yield* archives.export({ sessionID: session.id, engine })
        expect(exported.info).toMatchObject({ tokensOwnOnly: true, subagentTokensOwnOnly: true })
        const stamped =
          "engine" in exported
            ? Schema.encodeSync(SessionArchive.Native)({
                ...exported,
                info: { ...exported.info, tokensOwnOnly: true, subagentTokensOwnOnly: true },
              })
            : Schema.encodeSync(SessionArchive.Legacy)({
                ...exported,
                info: { ...exported.info, tokensOwnOnly: true, subagentTokensOwnOnly: true },
              })
        const before = structuredClone(stamped)
        const imported = yield* archives.import({ archive: stamped, location })
        expect(yield* sessions.get(imported.sessionID)).toMatchObject({
          tokensOwnOnly: false,
          subagentTokensOwnOnly: false,
        })
        expect(stamped).toEqual(before)
      }
      expect(observed).toHaveLength(2)
      for (const event of observed)
        expect(event).toMatchObject({ info: { tokensOwnOnly: false, subagentTokensOwnOnly: false } })
    }),
  )

  it.effect("a late or repeated initialize callback cannot recertify an existing aggregate", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location })
      const { db } = yield* Database.Service
      yield* SessionAccounting.invalidate(db, session.id)
      yield* SessionAccounting.initializeEmpty(db, session.id, 0)
      yield* SessionAccounting.initializeEmpty(db, session.id, 1)
      expect(yield* row(session.id)).toMatchObject({ tokens_own_only: false, subagent_tokens_own_only: false })
    }),
  )
})
