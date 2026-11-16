import { createHash } from "node:crypto"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { makeGlobalNode } from "@vectordevai/core/effect/app-node"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { EventTable } from "@vectordevai/core/event/sql"
import { PartTable, SessionMessageTable } from "@vectordevai/core/session/sql"
import { PublicSessionShareTable } from "@vectordevai/core/share/public.sql"
import { ComputerScreenshots } from "@vectordevai/core/util/computer-screenshots"
import { SessionID } from "@vectordevai/schema/session-id"
import { SessionV1 } from "@vectordevai/schema/session-v1"

export const Input = Schema.Struct({
  before: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  sessionID: Schema.optional(SessionID),
  all: Schema.optional(Schema.Boolean),
})
  .check(
    Schema.makeFilter(
      (input) =>
        input.all === true
          ? input.before === undefined && input.sessionID === undefined
          : input.before !== undefined || input.sessionID !== undefined,
      { expected: "all: true alone, or a before/sessionID selection" },
    ),
  )
  .annotate({ identifier: "ComputerPrune.Input" })
export type Input = typeof Input.Type

export const Result = Schema.Struct({ removed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }).annotate({
  identifier: "ComputerPrune.Result",
})
export type Result = typeof Result.Type

export class Error extends Schema.TaggedErrorClass<Error>()("ComputerPruneError", {
  code: Schema.Literals(["invalid", "storage"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly prune: (input: Input) => Effect.Effect<Result, Error>
}
export class Service extends Context.Service<Service, Interface>()("@vector/ComputerPrune") {}
export const use = serviceUse(Service)

const nativeTypes = [
  "session.next.tool.input.started.1",
  "session.next.tool.called.1",
  "session.next.tool.progress.1",
  "session.next.tool.success.1",
  "session.next.tool.failed.1",
  "session.next.message.imported.1",
]
const storageFailure = () =>
  new Error({ code: "storage", message: "Vector could not finish deleting the screenshots. Try again." })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db

    const prune: Interface["prune"] = Effect.fn("ComputerPrune.prune")(function* (input) {
      if (!Schema.is(Input)(input))
        return yield* new Error({ code: "invalid", message: "Choose all screenshots, a cutoff time, or a session." })
      const result = yield* Effect.scoped(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // Reserve the shared connection through COMMIT, VACUUM and WAL truncation. Ordinary writers cannot slip
            // between them; the transaction also serializes against another process using the same database file.
            const connection = yield* restore(db.$client.reserve)
            const execute = (query: string) => connection.executeUnprepared(query, [], undefined)
            yield* execute("BEGIN IMMEDIATE")
            const changed = yield* update(db, input).pipe(
              Effect.provideService(db.$client.transactionService, [connection, 0]),
              Effect.exit,
            )
            if (Exit.isFailure(changed)) {
              yield* execute("ROLLBACK")
              return yield* changed
            }
            yield* execute("COMMIT").pipe(Effect.onError(() => execute("ROLLBACK").pipe(Effect.ignore)))
            if (input.all) {
              yield* execute("VACUUM")
              const checkpoint = yield* execute("PRAGMA wal_checkpoint(TRUNCATE)")
              // SQLite reports busy readers as a successful PRAGMA row. They must not turn deletion into false success.
              if (checkpoint.some((row: Record<string, unknown>) => row.busy !== 0)) return yield* storageFailure()
            }
            return changed.value
          }),
        ),
      ).pipe(Effect.catchCause(() => storageFailure()))

      // Callers refresh history after pruning. Re-publishing whole parts here would overwrite a newer compaction
      // update that committed after the purge released its connection.
      return result
    })
    return Service.of({ prune })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

const update = Effect.fn("ComputerPrune.update")(function* (db: Database.Interface["db"], input: Input) {
  const partRows = yield* db
    .select()
    .from(PartTable)
    .where(
      and(
        input.sessionID ? eq(PartTable.session_id, input.sessionID) : undefined,
        sql`json_extract(${PartTable.data}, '$.type') = 'tool' and json_extract(${PartTable.data}, '$.tool') = 'computer'`,
      ),
    )
    .all()
  const eventRows = yield* db
    .select()
    .from(EventTable)
    .where(
      and(
        input.sessionID ? eq(EventTable.aggregate_id, input.sessionID) : undefined,
        inArray(EventTable.type, ["message.part.updated.1", ...nativeTypes]),
      ),
    )
    .all()
  const nativeRows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        input.sessionID ? eq(SessionMessageTable.session_id, input.sessionID) : undefined,
        eq(SessionMessageTable.type, "assistant"),
      ),
    )
    .all()
  const chosen = new Set<string>()
  const calls = new Map<string, number>()
  const native = new Set<string>()
  const nativeChosen = new Set<string>()
  let removed = 0

  const choose = (sessionID: string, part: unknown, fallback: number) => {
    const value = record(part)
    const state = record(value?.state)
    if (value?.type !== "tool" || value.tool !== "computer" || !state || typeof value.id !== "string") return
    const at = timestamp(record(state.time)?.end, fallback)
    if (typeof value.messageID === "string" && typeof value.callID === "string")
      calls.set(key(sessionID, value.messageID, value.callID), at)
    if (selected(at, input) && (hasMedia(state) || record(state.metadata)?.screenshotRemoved === true))
      chosen.add(key(sessionID, value.id))
  }
  const chooseNative = (sessionID: string, messageID: string, value: unknown, fallback: number) => {
    const part = record(value)
    const state = record(part?.state)
    if (part?.type !== "tool" || part.name !== "computer" || typeof part.id !== "string" || !state) return
    const id = key(sessionID, messageID, part.id)
    const at = timestamp(record(part.time)?.completed, timestamp(record(part.time)?.created, fallback))
    native.add(id)
    calls.set(id, at)
    if (selected(at, input) && (hasMedia(state) || record(state.structured)?.screenshotRemoved === true))
      nativeChosen.add(id)
  }

  for (const row of partRows)
    choose(row.session_id, { ...row.data, id: row.id, messageID: row.message_id }, row.time_created)
  for (const row of nativeRows)
    for (const part of array(record(row.data)?.content)) chooseNative(row.session_id, row.id, part, row.time_created)
  for (const row of eventRows) {
    const data = row.data
    if (row.type === "message.part.updated.1") choose(row.aggregate_id, data.part, timestamp(data.time, 0))
    const message = record(data.message)
    if (row.type === "session.next.message.imported.1" && typeof message?.id === "string")
      for (const part of array(message.content))
        chooseNative(row.aggregate_id, message.id, part, timestamp(data.timestamp, 0))
    if (
      (data.tool === "computer" || data.name === "computer") &&
      typeof data.assistantMessageID === "string" &&
      typeof data.callID === "string"
    )
      native.add(key(row.aggregate_id, data.assistantMessageID, data.callID))
  }
  for (const row of eventRows) {
    const data = row.data
    if (typeof data.assistantMessageID !== "string" || typeof data.callID !== "string") continue
    const id = key(row.aggregate_id, data.assistantMessageID, data.callID)
    if (
      native.has(id) &&
      selected(timestamp(data.timestamp, 0), input) &&
      (hasMedia(data) || record(data.structured)?.screenshotRemoved === true)
    )
      nativeChosen.add(id)
  }

  for (const row of partRows) {
    if (!chosen.has(key(row.session_id, row.id))) continue
    const original = { ...row.data, id: row.id, messageID: row.message_id, sessionID: row.session_id }
    const value = tombstone(original, "metadata")
    const state = record(record(original)?.state)
    removed += Array.isArray(state?.attachments) ? state.attachments.length : mediaCount(state)
    const part = Schema.decodeUnknownSync(SessionV1.Part)(value)
    const { id, messageID, sessionID, ...data } = part
    yield* db.update(PartTable).set({ data }).where(eq(PartTable.id, row.id)).run()
  }
  for (const row of nativeRows) {
    const data = record(row.data)
    if (!data || !Array.isArray(data.content)) continue
    let changed = false
    const content = data.content.map((part: unknown) => {
      const value = record(part)
      if (!value || typeof value.id !== "string" || !nativeChosen.has(key(row.session_id, row.id, value.id)))
        return part
      changed = true
      removed += mediaCount(value.state)
      return tombstone(value, "structured")
    })
    if (changed)
      yield* db
        .update(SessionMessageTable)
        .set({ data: { ...row.data, content } as typeof row.data })
        .where(eq(SessionMessageTable.id, row.id))
        .run()
  }
  for (const row of eventRows) {
    const data = row.data
    const part = record(data.part)
    if (
      row.type === "message.part.updated.1" &&
      typeof part?.id === "string" &&
      chosen.has(key(row.aggregate_id, part.id))
    ) {
      yield* db
        .update(EventTable)
        .set({ data: { ...data, part: tombstone(part, "metadata") } })
        .where(eq(EventTable.id, row.id))
        .run()
      continue
    }
    const message = record(data.message)
    if (
      row.type === "session.next.message.imported.1" &&
      message?.type === "assistant" &&
      typeof message.id === "string" &&
      Array.isArray(message.content)
    ) {
      let changed = false
      const content = array(message.content).map((part) => {
        const value = record(part)
        if (
          !value ||
          typeof value.id !== "string" ||
          !nativeChosen.has(key(row.aggregate_id, message.id as string, value.id))
        )
          return part
        changed = true
        return tombstone(value, "structured")
      })
      if (changed)
        yield* db
          .update(EventTable)
          .set({ data: { ...data, message: { ...message, content } } })
          .where(eq(EventTable.id, row.id))
          .run()
      continue
    }
    if (
      typeof data.assistantMessageID !== "string" ||
      typeof data.callID !== "string" ||
      !nativeChosen.has(key(row.aggregate_id, data.assistantMessageID, data.callID)) ||
      !["session.next.tool.progress.1", "session.next.tool.success.1", "session.next.tool.failed.1"].includes(row.type)
    )
      continue
    const clean = record(ComputerScreenshots.stripResult(data)) ?? {}
    if (row.type !== "session.next.tool.failed.1")
      clean.structured = { ...record(clean.structured), screenshotRemoved: true }
    yield* db.update(EventTable).set({ data: clean }).where(eq(EventTable.id, row.id)).run()
  }

  // A manual share still being created can retain an additional local archive. Published remote copies are owned
  // by the explicit share consent; this route removes the local database copy without attempting network deletion.
  const shares = yield* db
    .select()
    .from(PublicSessionShareTable)
    .where(input.sessionID ? eq(PublicSessionShareTable.session_id, input.sessionID) : undefined)
    .all()
  for (const row of shares) {
    if (!row.initial_archive) continue
    let changed = false
    const archive = {
      ...row.initial_archive,
      messages: row.initial_archive.messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) => {
          if (
            part.type !== "tool" ||
            part.name !== "computer" ||
            !part.screenshots ||
            !selected(calls.get(key(row.session_id, message.id, part.callID)) ?? message.createdAt, input)
          )
            return part
          changed = true
          const next = { ...part }
          delete next.screenshots
          return next
        }),
      })),
    }
    if (changed)
      yield* db
        .update(PublicSessionShareTable)
        .set({
          initial_archive: archive,
          content_hash: createHash("sha256").update(JSON.stringify(archive)).digest("hex"),
          dirty: true,
        })
        .where(eq(PublicSessionShareTable.session_id, row.session_id))
        .run()
  }
  return { removed }
})

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function key(...values: string[]) {
  return values.join("\0")
}
function timestamp(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}
function selected(at: number, input: Input) {
  return input.before === undefined || at < input.before
}
function hasMedia(value: unknown) {
  return JSON.stringify(value) !== JSON.stringify(ComputerScreenshots.stripResult(value))
}
function tombstone(value: Record<string, unknown>, field: "metadata" | "structured") {
  const state = record(ComputerScreenshots.stripResult(value.state)) ?? {}
  return { ...value, state: { ...state, [field]: { ...record(state[field]), screenshotRemoved: true } } }
}
function mediaCount(value: unknown): number {
  const found = new Set<string>()
  const walk = (item: unknown) => {
    if (Array.isArray(item)) return item.forEach(walk)
    const data = record(item)
    if (!data) return
    if (["file", "image", "image-data", "image-url", "media"].includes(String(data.type)))
      found.add(String(data.uri ?? data.url ?? data.data ?? JSON.stringify(data)))
    for (const [name, value] of Object.entries(data)) {
      if (name === "attachments" || name === "screenshots")
        for (const attachment of array(value)) {
          const file = record(attachment)
          found.add(String(file?.uri ?? file?.url ?? file?.data ?? JSON.stringify(attachment)))
        }
      else walk(value)
    }
  }
  walk(value)
  return found.size
}

export * as ComputerPrune from "./prune"
