import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { EventV2 } from "@vectordevai/core/event"
import { EventTable } from "@vectordevai/core/event/sql"
import { ModelV2 } from "@vectordevai/core/model"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { ProviderV2 } from "@vectordevai/core/provider"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionEvent } from "@vectordevai/core/session/event"
import { SessionMessage } from "@vectordevai/core/session/message"
import { Prompt } from "@vectordevai/core/session/prompt"
import { SessionMessageUpdater } from "@vectordevai/core/session/message-updater"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { SessionExecution } from "@vectordevai/core/session/execution"
import { SessionInput } from "@vectordevai/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@vectordevai/core/session/sql"
import { testEffect } from "./lib/effect"
import { Snapshot } from "@vectordevai/core/snapshot"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
  settlement?: {
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
  },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content: [], time, ...settlement }),
  )
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

describe("SessionProjector", () => {
  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const settlement = {
        cost: 1.5,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      }
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
          cost: settlement.cost,
          tokens_input: settlement.tokens.input,
          tokens_output: settlement.tokens.output,
          tokens_reasoning: settlement.tokens.reasoning,
          tokens_cache_read: settlement.tokens.cache.read,
          tokens_cache_write: settlement.tokens.cache.write,
        })
        .run()
      const boundary = SessionMessage.ID.make("msg_boundary")
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(boundary, 1),
          assistantRow(
            SessionMessage.ID.make("msg_later"),
            2,
            { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
            settlement,
          ),
        ])
        .run()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), diff: "patch", files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* events.publish(SessionEvent.RevertEvent.Cleared, { sessionID, timestamp: DateTime.makeUnsafe(2) })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: boundary, files: [] },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([boundary])
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      })
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: Prompt.make({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: Prompt.make({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("marks an inbox row promoted with the Prompted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      const admitted = yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: admitted.timeCreated,
        messageID: id,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
          time_updated: 10,
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: 10,
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("aggregates V2 step usage exactly once and replaces an assistant settlement", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const assistantMessageID = SessionMessage.ID.make("msg_assistant_usage")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: created,
        assistantMessageID,
        agent: "build",
        model,
      })
      const ended = yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID,
        finish: "stop",
        cost: 1.25,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      })
      const sessions = yield* SessionV2.Service

      expect(yield* sessions.get(sessionID)).toMatchObject({
        cost: 1.25,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      })

      const recorded = yield* db.select().from(EventTable).where(eq(EventTable.id, ended.id)).get().pipe(Effect.orDie)
      if (!recorded) return yield* Effect.die("Step settlement event was not recorded")
      yield* events.replay({
        id: recorded.id,
        aggregateID: recorded.aggregate_id,
        seq: recorded.seq,
        type: recorded.type,
        data: recorded.data,
      })

      expect(yield* sessions.get(sessionID)).toMatchObject({
        cost: 1.25,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      })

      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID,
        finish: "length",
        cost: 2.5,
        tokens: { input: 100, output: 200, reasoning: 30, cache: { read: 40, write: 50 } },
      })

      expect(yield* sessions.get(sessionID)).toMatchObject({
        cost: 2.5,
        tokens: { input: 100, output: 200, reasoning: 30, cache: { read: 40, write: 50 } },
      })
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("counts an unpriced V2 settlement and uncounts it when a priced one replaces it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const sessions = yield* SessionV2.Service
      const assistantMessageID = SessionMessage.ID.make("msg_assistant_unpriced")
      const tokens = { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: created,
        assistantMessageID,
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID,
        finish: "stop",
        cost: 0,
        unpriced: true,
        tokens,
      })

      expect(yield* sessions.get(sessionID)).toMatchObject({ cost: 0, unpricedSteps: 1 })
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      expect(row?.data).toMatchObject({ unpriced: true })

      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID,
        finish: "stop",
        cost: 0.5,
        tokens,
      })

      const replaced = yield* sessions.get(sessionID)
      expect(replaced.cost).toBe(0.5)
      expect(replaced.unpricedSteps).toBeUndefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("rolls a subagent's step usage up to every session above it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const childID = SessionV2.ID.make("ses_projector_child")
      const grandchildID = SessionV2.ID.make("ses_projector_grandchild")
      yield* db
        .insert(SessionTable)
        .values(
          [
            { id: sessionID, parent_id: undefined },
            { id: childID, parent_id: sessionID },
            { id: grandchildID, parent_id: childID },
          ].map((row) => ({
            ...row,
            project_id: Project.ID.global,
            slug: row.id,
            directory: "/project",
            title: row.id,
            version: "test",
          })),
        )
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const sessions = yield* SessionV2.Service
      const tokens = { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }
      const step = (session: SessionV2.ID, assistantMessageID: SessionMessage.ID, cost: number, unpriced?: true) =>
        Effect.gen(function* () {
          yield* events.publish(SessionEvent.Step.Started, {
            sessionID: session,
            timestamp: created,
            assistantMessageID,
            agent: "build",
            model,
          })
          yield* events.publish(SessionEvent.Step.Ended, {
            sessionID: session,
            timestamp: DateTime.makeUnsafe(1),
            assistantMessageID,
            finish: "stop",
            cost,
            ...(unpriced ? { unpriced } : {}),
            tokens,
          })
        })
      const deep = SessionMessage.ID.make("msg_grandchild_step")
      yield* step(grandchildID, deep, 1.25)
      yield* step(childID, SessionMessage.ID.make("msg_child_step"), 0, true)
      yield* step(sessionID, SessionMessage.ID.make("msg_root_step"), 0.5)

      expect(yield* sessions.get(sessionID)).toMatchObject({ cost: 0.5, subagentCost: 1.25, subagentUnpricedSteps: 1 })
      expect(yield* sessions.get(childID)).toMatchObject({ cost: 0, unpricedSteps: 1, subagentCost: 1.25 })
      const grandchild = yield* sessions.get(grandchildID)
      expect(grandchild.cost).toBe(1.25)
      expect(grandchild.subagentCost).toBeUndefined()

      // A settlement that replaces an earlier one moves the ancestors' totals by the difference.
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: grandchildID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: deep,
        finish: "stop",
        cost: 2,
        tokens,
      })
      expect(yield* sessions.get(sessionID)).toMatchObject({ cost: 0.5, subagentCost: 2, subagentUnpricedSteps: 1 })
      expect(yield* sessions.get(childID)).toMatchObject({ subagentCost: 2 })
      // Tokens roll up beside cost, so the root's meter can count what its subagents used.
      expect((yield* sessions.get(sessionID)).subagentTokens).toEqual({
        input: 20,
        output: 40,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      })
      expect((yield* sessions.get(childID)).subagentTokens).toEqual(tokens)
      expect(grandchild.subagentTokens).toBeUndefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("counts a helper session's spend towards the session that launched it and lists only that session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const helperID = SessionV2.ID.make("ses_projector_helper")
      const standaloneID = SessionV2.ID.make("ses_projector_standalone_helper")
      yield* db
        .insert(SessionTable)
        .values(
          [
            { id: sessionID, parent_id: undefined, internal: undefined },
            { id: helperID, parent_id: sessionID, internal: "vectorscope.review" },
            { id: standaloneID, parent_id: undefined, internal: "vectorscope.verify" },
          ].map((row) => ({
            ...row,
            project_id: Project.ID.global,
            slug: row.id,
            directory: "/project",
            title: row.id,
            version: "test",
          })),
        )
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const sessions = yield* SessionV2.Service
      const tokens = { input: 100, output: 30, reasoning: 5, cache: { read: 7, write: 1 } }
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: helperID,
        timestamp: created,
        assistantMessageID: SessionMessage.ID.make("msg_helper_step"),
        agent: "review",
        model,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: helperID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_helper_step"),
        finish: "stop",
        cost: 0.75,
        tokens,
      })

      const helper = yield* sessions.get(helperID)
      expect(helper).toMatchObject({ internal: "vectorscope.review", parentID: sessionID, cost: 0.75 })
      expect(yield* sessions.get(sessionID)).toMatchObject({ cost: 0, subagentCost: 0.75, subagentTokens: tokens })
      expect((yield* sessions.list({ limit: 1 })).map((session) => session.id)).toEqual([sessionID])
      // A corrupt imported parent cycle must never roll a session's own spend back into itself.
      yield* db.update(SessionTable).set({ parent_id: helperID }).where(eq(SessionTable.id, sessionID)).run()
      yield* events.publish(SessionEvent.AncillaryUsage, {
        sessionID: helperID,
        timestamp: DateTime.makeUnsafe(2),
        usageID: EventV2.ID.create(),
        purpose: "title",
        model,
        cost: 0.25,
        tokens,
      })
      expect((yield* sessions.get(helperID)).cost).toBe(1)
      expect((yield* sessions.get(helperID)).subagentCost).toBeUndefined()
      expect((yield* sessions.get(sessionID)).subagentCost).toBe(1)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})

it.effect("ancillary usage survives replay and transcript reverts without creating messages", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const parentID = SessionV2.ID.make("ses_ancillary_parent")
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* database.db
      .insert(SessionTable)
      .values([
        {
          id: parentID,
          project_id: Project.ID.global,
          slug: "parent",
          directory: "/project",
          title: "parent",
          version: "test",
        },
        {
          id: sessionID,
          parent_id: parentID,
          project_id: Project.ID.global,
          slug: "child",
          directory: "/project",
          title: "child",
          version: "test",
        },
      ])
      .run()
    const usageID = EventV2.ID.create()
    const first = yield* events.publish(
      SessionEvent.AncillaryUsage,
      {
        sessionID,
        timestamp: created,
        usageID,
        purpose: "title",
        model,
        cost: 0.25,
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 4, write: 5 } },
      },
      { id: usageID },
    )
    yield* events.publish(SessionEvent.AncillaryUsage, {
      sessionID,
      timestamp: created,
      usageID: EventV2.ID.create(),
      purpose: "title",
      model,
      cost: 0.1,
      unpriced: true,
      incomplete: true,
      tokens: { input: 7, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const recorded = yield* database.db.select().from(EventTable).where(eq(EventTable.id, first.id)).get()
    if (!recorded) return yield* Effect.die("Missing ancillary event")
    yield* events.replay({
      id: recorded.id,
      aggregateID: recorded.aggregate_id,
      seq: recorded.seq,
      type: recorded.type,
      data: recorded.data,
    })
    expect(yield* database.db.select().from(SessionMessageTable).all()).toHaveLength(0)
    const boundary = SessionMessage.ID.make("msg_ancillary_boundary")
    yield* database.db.insert(SessionMessageTable).values(assistantRow(boundary, 10)).run()
    yield* events.publish(SessionEvent.RevertEvent.Committed, { sessionID, messageID: boundary, timestamp: created })
    const session = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
    expect(session?.cost).toBeCloseTo(0.35)
    expect(session?.unpriced_steps).toBe(1)
    expect(session?.tokens_input).toBe(17)
    expect(session?.tokens_output).toBe(2)
    const parent = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, parentID)).get()
    expect(parent?.subagent_cost).toBeCloseTo(0.35)
    expect(parent?.subagent_unpriced_steps).toBe(1)
    expect(parent?.tokens_input).toBe(0)
  }),
)

it.effect("descendant spend advances ancestor freshness for equal and older timestamps without replay inflation", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const root = SessionV2.ID.make("ses_freshness_root")
    const child = SessionV2.ID.make("ses_freshness_child")
    const grandchild = SessionV2.ID.make("ses_freshness_grandchild")
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* database.db
      .insert(SessionTable)
      .values(
        [
          { id: root, parent_id: null },
          { id: child, parent_id: root },
          { id: grandchild, parent_id: child },
        ].map((row) => ({
          ...row,
          project_id: Project.ID.global,
          slug: row.id,
          directory: "/project",
          title: row.id,
          version: "test",
          time_created: 1000,
          time_updated: 1000,
        })),
      )
      .run()
    const get = (id: typeof root) => database.db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()
    const usageID = EventV2.ID.create()
    yield* events.publish(
      SessionEvent.AncillaryUsage,
      {
        sessionID: grandchild,
        timestamp: DateTime.makeUnsafe(1000),
        usageID,
        purpose: "title",
        model,
        cost: 0.25,
        tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { id: usageID },
    )
    const first = yield* get(root)
    expect(first?.time_updated).toBe(1001)
    expect(first?.subagent_cost).toBe(0.25)
    const recorded = yield* database.db.select().from(EventTable).where(eq(EventTable.id, usageID)).get()
    if (!recorded) return yield* Effect.die("Missing usage event")
    yield* events.replay({
      id: recorded.id,
      aggregateID: recorded.aggregate_id,
      seq: recorded.seq,
      type: recorded.type,
      data: recorded.data,
    })
    expect((yield* get(root))?.time_updated).toBe(1001)
    yield* events.publish(SessionEvent.AncillaryUsage, {
      sessionID: grandchild,
      timestamp: DateTime.makeUnsafe(5000),
      usageID: EventV2.ID.create(),
      purpose: "title",
      model,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    expect((yield* get(root))?.time_updated).toBe(1001)
    yield* events.publish(SessionEvent.AncillaryUsage, {
      sessionID: grandchild,
      timestamp: DateTime.makeUnsafe(1),
      usageID: EventV2.ID.create(),
      purpose: "title",
      model,
      incomplete: true,
    })
    const second = yield* get(root)
    expect(second?.time_updated).toBe(1002)
    expect(second?.subagent_unpriced_steps).toBe(1)
    expect((yield* get(child))?.subagent_unpriced_steps).toBe(1)
    yield* events.publish(SessionV1.Event.Updated, {
      sessionID: root,
      info: {
        id: root,
        projectID: Project.ID.global,
        slug: root,
        directory: "/project",
        title: "late metadata",
        version: "test",
        time: { created: 1000, updated: 1000 },
      },
    })
    expect(yield* get(root)).toMatchObject({
      time_created: 1000,
      time_updated: 1002,
      subagent_cost: 0.25,
      subagent_unpriced_steps: 1,
      tokens_input: 0,
      tokens_output: 0,
    })
    expect(yield* database.db.select().from(SessionMessageTable).all()).toHaveLength(0)
  }),
)

describe("Codium accounting", () => {
  const rootID = SessionV2.ID.make("ses_codium_root")
  const childID = SessionV2.ID.make("ses_codium_child")
  const leafID = SessionV2.ID.make("ses_codium_leaf")
  const codiumModel = { id: ModelV2.ID.make("deepseek"), providerID: ProviderV2.ID.make("vector-plan") }
  const tokens = { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } }
  const noTokens = {
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
  }
  const noSubagentTokens = {
    subagent_tokens_input: 0,
    subagent_tokens_output: 0,
    subagent_tokens_reasoning: 0,
    subagent_tokens_cache_read: 0,
    subagent_tokens_cache_write: 0,
  }

  // A root with a child and a grandchild, so a step on the leaf rolls up through two ancestors.
  const setup = Effect.fn("test.codiumSessions")(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values(
        [
          { id: rootID, parent_id: undefined },
          { id: childID, parent_id: rootID },
          { id: leafID, parent_id: childID },
        ].map((row) => ({
          ...row,
          project_id: Project.ID.global,
          slug: row.id,
          directory: "/project",
          title: row.id,
          version: "test",
        })),
      )
      .run()
      .pipe(Effect.orDie)
    const row = (id: SessionV2.ID) =>
      db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
    const message = (id: SessionMessage.ID) =>
      db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie)
    return { db, events: yield* EventV2.Service, row, message }
  })

  it.effect("counts a Codium settlement as one unpriced Codium step with no tokens, up every ancestor", () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* SessionV2.Service
      const boundary = SessionMessage.ID.make("msg_codium_boundary")
      const step = SessionMessage.ID.make("msg_codium_step")
      yield* test.events.publish(SessionEvent.Step.Started, {
        sessionID: leafID,
        timestamp: created,
        assistantMessageID: boundary,
        agent: "build",
        model: codiumModel,
      })
      yield* test.events.publish(SessionEvent.Step.Started, {
        sessionID: leafID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: step,
        agent: "build",
        model: codiumModel,
      })
      const ended = yield* test.events.publish(SessionEvent.Step.Ended, {
        sessionID: leafID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: step,
        finish: "stop",
        cost: 0,
        unpriced: true,
        billing: "codium",
        tokens,
      })
      expect((yield* test.message(step))?.data).toMatchObject({ billing: "codium", unpriced: true, tokens })
      expect(yield* test.row(leafID)).toMatchObject({ cost: 0, unpriced_steps: 1, codium_steps: 1, ...noTokens })
      for (const id of [childID, rootID])
        expect(yield* test.row(id)).toMatchObject({
          subagent_cost: 0,
          subagent_unpriced_steps: 1,
          subagent_codium_steps: 1,
          ...noSubagentTokens,
          codium_steps: 0,
        })
      expect(yield* sessions.get(leafID)).toMatchObject({ unpricedSteps: 1, codiumSteps: 1 })
      expect(yield* sessions.get(rootID)).toMatchObject({ subagentUnpricedSteps: 1, subagentCodiumSteps: 1 })
      expect((yield* sessions.get(rootID)).codiumSteps).toBeUndefined()
      expect((yield* sessions.get(rootID)).subagentTokens).toBeUndefined()

      // A replayed settlement is projected once.
      const recorded = yield* test.db.select().from(EventTable).where(eq(EventTable.id, ended.id)).get()
      if (!recorded) return yield* Effect.die("Codium settlement was not recorded")
      yield* test.events.replay({
        id: recorded.id,
        aggregateID: recorded.aggregate_id,
        seq: recorded.seq,
        type: recorded.type,
        data: recorded.data,
      })
      expect(yield* test.row(leafID)).toMatchObject({ unpriced_steps: 1, codium_steps: 1, ...noTokens })

      // An own settlement replacing the Codium one moves every total by the difference, and back again.
      yield* test.events.publish(SessionEvent.Step.Ended, {
        sessionID: leafID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: step,
        finish: "stop",
        cost: 0.5,
        tokens,
      })
      expect((yield* test.message(step))?.data).not.toHaveProperty("billing")
      expect(yield* test.row(leafID)).toMatchObject({
        cost: 0.5,
        unpriced_steps: 0,
        codium_steps: 0,
        tokens_input: 10,
        tokens_cache_write: 5,
      })
      expect(yield* test.row(rootID)).toMatchObject({
        subagent_cost: 0.5,
        subagent_unpriced_steps: 0,
        subagent_codium_steps: 0,
        subagent_tokens_input: 10,
        subagent_tokens_cache_write: 5,
      })
      yield* test.events.publish(SessionEvent.Step.Ended, {
        sessionID: leafID,
        timestamp: DateTime.makeUnsafe(4),
        assistantMessageID: step,
        finish: "stop",
        cost: 0,
        unpriced: true,
        billing: "codium",
        tokens,
      })
      expect(yield* test.row(leafID)).toMatchObject({ cost: 0, unpriced_steps: 1, codium_steps: 1, ...noTokens })
      expect(yield* test.row(childID)).toMatchObject({
        subagent_cost: 0,
        subagent_unpriced_steps: 1,
        subagent_codium_steps: 1,
        ...noSubagentTokens,
      })

      // A revert past the step takes it back out of the session and every ancestor.
      yield* test.events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID: leafID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(5),
      })
      expect(yield* test.row(leafID)).toMatchObject({ cost: 0, unpriced_steps: 0, codium_steps: 0, ...noTokens })
      for (const id of [childID, rootID])
        expect(yield* test.row(id)).toMatchObject({
          subagent_unpriced_steps: 0,
          subagent_codium_steps: 0,
          ...noSubagentTokens,
        })
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("keeps the Codium counts when a session update carrying stale totals lands after a step", () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const step = SessionMessage.ID.make("msg_codium_before_update")
      yield* test.events.publish(SessionEvent.Step.Started, {
        sessionID: childID,
        timestamp: created,
        assistantMessageID: step,
        agent: "build",
        model: codiumModel,
      })
      yield* test.events.publish(SessionEvent.Step.Ended, {
        sessionID: childID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: step,
        finish: "stop",
        cost: 0,
        unpriced: true,
        billing: "codium",
        tokens,
      })
      // What a title change or a metadata update read before the step settled, or a client's wrong copy of it.
      const stale = (id: SessionV2.ID, counts: { codiumSteps?: number; subagentCodiumSteps?: number }) => ({
        id,
        projectID: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "renamed",
        version: "test",
        time: { created: 0, updated: 0 },
        ...counts,
      })
      yield* test.events.publish(SessionV1.Event.Updated, { sessionID: childID, info: stale(childID, {}) })
      yield* test.events.publish(SessionV1.Event.Updated, {
        sessionID: rootID,
        info: stale(rootID, { codiumSteps: 7, subagentCodiumSteps: 7 }),
      })
      expect(yield* test.row(childID)).toMatchObject({ title: "renamed", unpriced_steps: 1, codium_steps: 1 })
      expect(yield* test.row(rootID)).toMatchObject({
        title: "renamed",
        codium_steps: 0,
        subagent_unpriced_steps: 1,
        subagent_codium_steps: 1,
      })
    }),
  )

  it.effect("routes Codium titles, compaction summaries and failed summaries like Codium steps", () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const boundary = SessionMessage.ID.make("msg_codium_compaction_boundary")
      yield* test.events.publish(SessionEvent.Step.Started, {
        sessionID: childID,
        timestamp: created,
        assistantMessageID: boundary,
        agent: "build",
        model: codiumModel,
      })
      // The engine's title helper marks its record; an older record is still read as Codium from its model, because
      // nothing ever subtracts ancillary usage.
      yield* test.events.publish(SessionEvent.AncillaryUsage, {
        sessionID: childID,
        timestamp: DateTime.makeUnsafe(1),
        usageID: EventV2.ID.create(),
        purpose: "title",
        model: codiumModel,
        cost: 0,
        unpriced: true,
        billing: "codium",
        tokens,
      })
      yield* test.events.publish(SessionEvent.AncillaryUsage, {
        sessionID: childID,
        timestamp: DateTime.makeUnsafe(2),
        usageID: EventV2.ID.create(),
        purpose: "memory",
        model: codiumModel,
        cost: 0,
        tokens,
      })
      expect(yield* test.row(childID)).toMatchObject({ unpriced_steps: 2, codium_steps: 2, ...noTokens })
      const summary = SessionMessage.ID.make("msg_codium_summary")
      yield* test.events.publish(SessionEvent.Compaction.Ended, {
        sessionID: childID,
        messageID: summary,
        timestamp: DateTime.makeUnsafe(3),
        reason: "auto",
        text: "summary",
        recent: "",
        cost: 0,
        unpriced: true,
        billing: "codium",
        tokens,
      })
      expect((yield* test.message(summary))?.data).toMatchObject({ billing: "codium", unpriced: true, tokens })
      yield* test.events.publish(SessionEvent.Compaction.Failed, {
        sessionID: childID,
        messageID: SessionMessage.ID.make("msg_codium_failed_summary"),
        timestamp: DateTime.makeUnsafe(4),
        reason: "auto",
        cost: 0,
        unpriced: true,
        billing: "codium",
        tokens,
      })
      expect(yield* test.row(childID)).toMatchObject({ cost: 0, unpriced_steps: 4, codium_steps: 4, ...noTokens })
      expect(yield* test.row(rootID)).toMatchObject({
        subagent_unpriced_steps: 4,
        subagent_codium_steps: 4,
        ...noSubagentTokens,
      })

      // A revert past the summary takes back only the summary row; titles and the failed request stay billed.
      yield* test.events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID: childID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(5),
      })
      expect(yield* test.row(childID)).toMatchObject({ unpriced_steps: 3, codium_steps: 3, ...noTokens })
      expect(yield* test.row(rootID)).toMatchObject({ subagent_unpriced_steps: 3, subagent_codium_steps: 3 })
    }),
  )

  it.effect("counts an imported Codium row once and takes it back on revert", () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const boundary = SessionMessage.ID.make("msg_import_boundary")
      const imported = SessionMessage.ID.make("msg_import_codium")
      yield* test.events.publish(SessionEvent.Step.Started, {
        sessionID: childID,
        timestamp: created,
        assistantMessageID: boundary,
        agent: "build",
        model: codiumModel,
      })
      yield* test.events.publish(SessionEvent.MessageImported, {
        sessionID: childID,
        timestamp: DateTime.makeUnsafe(1),
        message: SessionMessage.Assistant.make({
          id: imported,
          type: "assistant",
          agent: "build",
          model: codiumModel,
          content: [],
          cost: 0,
          unpriced: true,
          billing: "codium",
          tokens,
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
      })
      expect(yield* test.row(childID)).toMatchObject({ unpriced_steps: 1, codium_steps: 1, ...noTokens })
      expect(yield* test.row(rootID)).toMatchObject({ subagent_codium_steps: 1, ...noSubagentTokens })
      yield* test.events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID: childID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(3),
      })
      expect(yield* test.row(childID)).toMatchObject({ unpriced_steps: 0, codium_steps: 0, ...noTokens })
      expect(yield* test.row(rootID)).toMatchObject({ subagent_unpriced_steps: 0, subagent_codium_steps: 0 })
    }),
  )

  it.effect("subtracts a Codium step recorded before the flag as the ordinary step it was counted as", () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const sessions = yield* SessionV2.Service
      const boundary = SessionMessage.ID.make("msg_flagless_boundary")
      const settled = SessionMessage.ID.make("msg_flagless_settled")
      yield* test.events.publish(SessionEvent.Step.Started, {
        sessionID: childID,
        timestamp: created,
        assistantMessageID: boundary,
        agent: "build",
        model: codiumModel,
      })
      // Settled on a Codium model before the flag existed: counted as an ordinary unpriced step with its tokens.
      yield* test.events.publish(SessionEvent.Step.Started, {
        sessionID: childID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: settled,
        agent: "build",
        model: codiumModel,
      })
      yield* test.events.publish(SessionEvent.Step.Ended, {
        sessionID: childID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: settled,
        finish: "stop",
        cost: 0,
        unpriced: true,
        tokens,
      })
      yield* test.events.publish(SessionEvent.MessageImported, {
        sessionID: childID,
        timestamp: DateTime.makeUnsafe(3),
        message: SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_flagless_imported"),
          type: "assistant",
          agent: "build",
          model: codiumModel,
          content: [],
          cost: 0,
          unpriced: true,
          tokens,
          time: { created: DateTime.makeUnsafe(3), completed: DateTime.makeUnsafe(4) },
        }),
      })
      expect(yield* test.row(childID)).toMatchObject({
        unpriced_steps: 2,
        codium_steps: 0,
        tokens_input: 20,
        tokens_output: 40,
      })
      expect(yield* test.row(rootID)).toMatchObject({ subagent_codium_steps: 0, subagent_tokens_input: 20 })

      yield* test.events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID: childID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(5),
      })
      expect(yield* test.row(childID)).toMatchObject({ unpriced_steps: 0, codium_steps: 0, ...noTokens })
      for (const id of [childID, rootID])
        expect(yield* test.row(id)).toMatchObject({ subagent_codium_steps: 0, ...noSubagentTokens })
      // The counts never go below 0, so the session still encodes.
      expect((yield* sessions.get(childID)).codiumSteps).toBeUndefined()
      expect((yield* sessions.get(rootID)).subagentCodiumSteps).toBeUndefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )
})
