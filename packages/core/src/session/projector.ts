export * as SessionProjector from "./projector"

import { and, desc, eq, gt, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { SessionContextEpoch } from "./context-epoch"
import { MessageTable, PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import type { DeepMutable } from "../schema"
import { PublicSession } from "@vectordevai/schema/public-session"
import { Billing } from "@vectordevai/schema/billing"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  // The step ran on a model with no listed price; it counts towards the session's unpriced_steps.
  unpriced?: boolean
  // The step ran on Vector Codium. Only the flag stored on the record routes it, never the provider id: a Codium step
  // recorded before the flag existed was counted as an ordinary step, so it must be subtracted as one.
  billing?: "codium"
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return {
    cost: value.cost as Usage["cost"],
    unpriced: value.unpriced === true,
    billing: value.billing === "codium" ? "codium" : undefined,
    tokens: value.tokens as Usage["tokens"],
  }
}

function rowUsage(row: typeof SessionMessageTable.$inferSelect | undefined): Usage | undefined {
  if (!row || (row.type !== "assistant" && row.type !== "compaction")) return undefined
  return messageUsage(decodeMessage({ ...row.data, id: row.id, type: row.type }))
}

// Assistant steps and compaction summaries are the messages that carry provider usage.
function messageUsage(message: SessionMessage.Message): Usage | undefined {
  if (message.type !== "assistant" && message.type !== "compaction") return undefined
  if (message.cost === undefined || message.tokens === undefined) return undefined
  return { cost: message.cost, unpriced: message.unpriced === true, billing: message.billing, tokens: message.tokens }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    internal: info.internal,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: Schema.is(PublicSession.Info)(info.share) ? undefined : info.share?.url,
    share_info: Schema.is(PublicSession.Info)(info.share) ? info.share : null,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    unpriced_steps: info.unpricedSteps ?? 0,
    codium_steps: info.codiumSteps ?? 0,
    subagent_cost: info.subagentCost ?? 0,
    subagent_unpriced_steps: info.subagentUnpricedSteps ?? 0,
    subagent_codium_steps: info.subagentCodiumSteps ?? 0,
    subagent_tokens_input: info.subagentTokens?.input ?? 0,
    subagent_tokens_output: info.subagentTokens?.output ?? 0,
    subagent_tokens_reasoning: info.subagentTokens?.reasoning ?? 0,
    subagent_tokens_cache_read: info.subagentTokens?.cache.read ?? 0,
    subagent_tokens_cache_write: info.subagentTokens?.cache.write ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
  timestamp = 0,
  previous?: Usage,
) {
  return Effect.gen(function* () {
    // Each record is routed by its own flag on both sides, so a replaced, reverted, removed or moved Codium step takes
    // back exactly what it added.
    const next = contribution(value)
    const prior = contribution(previous)
    const delta = {
      cost: next.cost * sign - prior.cost,
      unpriced: next.unpriced * sign - prior.unpriced,
      codium: next.codium * sign - prior.codium,
      input: next.input * sign - prior.input,
      output: next.output * sign - prior.output,
      reasoning: next.reasoning * sign - prior.reasoning,
      read: next.read * sign - prior.read,
      write: next.write * sign - prior.write,
    }
    if (Object.values(delta).every((value) => value === 0)) return
    yield* db
      .update(SessionTable)
      .set({
        cost: sql`${SessionTable.cost} + ${delta.cost}`,
        unpriced_steps: sql`${SessionTable.unpriced_steps} + ${delta.unpriced}`,
        codium_steps: sql`${SessionTable.codium_steps} + ${delta.codium}`,
        tokens_input: sql`${SessionTable.tokens_input} + ${delta.input}`,
        tokens_output: sql`${SessionTable.tokens_output} + ${delta.output}`,
        tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${delta.reasoning}`,
        tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${delta.read}`,
        tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${delta.write}`,
        time_updated: sql`max(${SessionTable.time_updated} + 1, ${timestamp})`,
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
    // A subagent's spend also counts towards every session above it, so a parent's total covers what it delegated.
    // Helper sessions Vector runs for a session (a Vectorscope review, autocomplete) are linked the same way.
    // The modified time is also the freshness revision read by economics consumers. Delegated spend must
    // invalidate a parent even when cancellation means it will never run or emit idle again.
    // UNION rather than UNION ALL stops the walk if a parent chain ever loops.
    yield* db
      .update(SessionTable)
      .set({
        subagent_cost: sql`${SessionTable.subagent_cost} + ${delta.cost}`,
        subagent_unpriced_steps: sql`${SessionTable.subagent_unpriced_steps} + ${delta.unpriced}`,
        subagent_codium_steps: sql`${SessionTable.subagent_codium_steps} + ${delta.codium}`,
        subagent_tokens_input: sql`${SessionTable.subagent_tokens_input} + ${delta.input}`,
        subagent_tokens_output: sql`${SessionTable.subagent_tokens_output} + ${delta.output}`,
        subagent_tokens_reasoning: sql`${SessionTable.subagent_tokens_reasoning} + ${delta.reasoning}`,
        subagent_tokens_cache_read: sql`${SessionTable.subagent_tokens_cache_read} + ${delta.read}`,
        subagent_tokens_cache_write: sql`${SessionTable.subagent_tokens_cache_write} + ${delta.write}`,
        time_updated: sql`max(${SessionTable.time_updated} + 1, ${timestamp})`,
      })
      .where(
        sql`${SessionTable.id} IN (WITH RECURSIVE ancestor(id) AS (SELECT parent_id FROM session WHERE id = ${sessionID} UNION SELECT session.parent_id FROM session JOIN ancestor ON session.id = ancestor.id) SELECT id FROM ancestor WHERE id IS NOT NULL AND id != ${sessionID})`,
      )
      .run()
      .pipe(Effect.orDie)
  })
}

// What one record adds to the session totals. A Codium step is one unpriced step and one Codium step and nothing else:
// its tokens stay on the record, for compaction and the context meter, but every token total leaves them out.
function contribution(value: Usage | undefined) {
  if (value?.billing === "codium")
    return { cost: 0, unpriced: 1, codium: 1, input: 0, output: 0, reasoning: 0, read: 0, write: 0 }
  return {
    cost: value?.cost ?? 0,
    unpriced: Number(Boolean(value?.unpriced)),
    codium: 0,
    input: value?.tokens.input ?? 0,
    output: value?.tokens.output ?? 0,
    reasoning: value?.tokens.reasoning ?? 0,
    read: value?.tokens.cache.read ?? 0,
    write: value?.tokens.cache.write ?? 0,
  }
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* events.project(SessionEvent.MessageImported, (event) =>
      Effect.gen(function* () {
        yield* insertMessage(db, event, event.data.message)
        // Revert and removal subtract a row's usage, so importing one adds it, as a replayed V1 archive does.
        const usage = messageUsage(event.data.message)
        if (usage) yield* applyUsage(db, event.data.sessionID, usage, 1, DateTime.toEpochMillis(event.data.timestamp))
      }),
    )
    yield* events.project(SessionEvent.ShareChanged, (event) =>
      db
        .update(SessionTable)
        .set({ share_info: event.data.share })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) => {
      // The usage columns belong to the step accounting below. A patch carries the totals it read before publishing,
      // so writing them back would erase every step that settled in between, such as one landing while a title is
      // generated or a subagent's record is updated.
      const {
        cost: _,
        unpriced_steps: _unpriced,
        codium_steps: _codium,
        subagent_cost: _subagentCost,
        subagent_unpriced_steps: _subagentUnpriced,
        subagent_codium_steps: _subagentCodium,
        subagent_tokens_input: _subagentInput,
        subagent_tokens_output: _subagentOutput,
        subagent_tokens_reasoning: _subagentReasoning,
        subagent_tokens_cache_read: _subagentCacheRead,
        subagent_tokens_cache_write: _subagentCacheWrite,
        tokens_input: __,
        tokens_output: ___,
        tokens_reasoning: ____,
        tokens_cache_read: _____,
        tokens_cache_write: ______,
        ...settings
      } = sessionRow(event.data.info)
      return db
        .update(SessionTable)
        .set({ ...settings, time_updated: sql`max(${SessionTable.time_updated}, ${settings.time_updated ?? 0})` })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie)
    })
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: sql`max(${SessionTable.time_updated}, ${DateTime.toEpochMillis(event.data.timestamp)})`,
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        if (event.data.info.role === "assistant" && event.data.info.time.completed !== undefined)
          yield* db
            .update(SessionTable)
            .set({ time_updated: sql`max(${SessionTable.time_updated}, ${event.data.info.time.completed})` })
            .where(eq(SessionTable.id, sessionID))
            .run()
            .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        yield* db
          .insert(PartTable)
          .values({ id, message_id: messageID, session_id: sessionID, time_created: event.data.time, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (next && row?.session_id === sessionID)
          return yield* applyUsage(db, sessionID, next, 1, event.data.time, previous)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1, event.data.time)
        if (next) yield* applyUsage(db, sessionID, next, 1, event.data.time)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({
          agent: event.data.agent,
          time_updated: sql`max(${SessionTable.time_updated}, ${DateTime.toEpochMillis(event.data.timestamp)})`,
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            model: event.data.model,
            time_updated: sql`max(${SessionTable.time_updated}, ${DateTime.toEpochMillis(event.data.timestamp)})`,
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.id, event.data.assistantMessageID),
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.type, "assistant"),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!row) {
          yield* run(db, event)
          return
        }
        const previous = rowUsage(row)
        yield* run(db, event)
        yield* applyUsage(
          db,
          event.data.sessionID,
          event.data,
          1,
          DateTime.toEpochMillis(event.data.timestamp),
          previous,
        )
      }),
    )
    yield* events.project(SessionEvent.AncillaryUsage, (event) =>
      Effect.gen(function* () {
        yield* applyUsage(
          db,
          event.data.sessionID,
          {
            cost: event.data.cost ?? 0,
            unpriced:
              event.data.unpriced ||
              event.data.incomplete ||
              event.data.cost === undefined ||
              event.data.tokens === undefined,
            // Nothing subtracts ancillary usage, so its model's provider id can route it as well as the flag.
            billing:
              event.data.billing === "codium" || Billing.isCodium(event.data.model.providerID) ? "codium" : undefined,
            tokens: event.data.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          1,
          DateTime.toEpochMillis(event.data.timestamp),
        )
      }),
    )
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Resumed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Failed, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        if (event.data.cost === undefined || event.data.tokens === undefined) return
        yield* applyUsage(
          db,
          event.data.sessionID,
          {
            cost: event.data.cost,
            unpriced: event.data.unpriced === true,
            billing: event.data.billing,
            tokens: event.data.tokens,
          },
          1,
          DateTime.toEpochMillis(event.data.timestamp),
        )
      }),
    )
    yield* events.project(SessionEvent.Compaction.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        if (event.data.cost === undefined || event.data.tokens === undefined) return
        yield* applyUsage(
          db,
          event.data.sessionID,
          {
            cost: event.data.cost,
            unpriced: event.data.unpriced === true,
            billing: event.data.billing,
            tokens: event.data.tokens,
          },
          1,
          DateTime.toEpochMillis(event.data.timestamp),
        )
      }),
    )
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: sql`max(${SessionTable.time_updated}, ${DateTime.toEpochMillis(event.data.timestamp)})`,
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: null,
          time_updated: sql`max(${SessionTable.time_updated}, ${DateTime.toEpochMillis(event.data.timestamp)})`,
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.id, event.data.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${event.data.messageID}`)
        const removed = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .all()
          .pipe(Effect.orDie)
        yield* Effect.forEach(
          removed,
          (row) => {
            const value = rowUsage(row)
            return value
              ? applyUsage(db, event.data.sessionID, value, -1, DateTime.toEpochMillis(event.data.timestamp))
              : Effect.void
          },
          { discard: true },
        )
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({
            revert: null,
            time_updated: sql`max(${SessionTable.time_updated}, ${DateTime.toEpochMillis(event.data.timestamp)})`,
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
