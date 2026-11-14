export * as ComputerScreenshotEvents from "./screenshot-events"

import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { SessionMessageTable } from "../session/sql"
import { ComputerScreenshots } from "../util/computer-screenshots"

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Resolve the owning tool, rather than treating every native tool's file output as a screenshot. */
export const name = Effect.fn("ComputerScreenshotEvents.name")(function* (
  database: Database.Interface,
  input: { sessionID: string; assistantMessageID: string; callID: string },
) {
  const db = database.db
  const current = yield* db
    .select({ data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(
      and(
        sql`${SessionMessageTable.session_id} = ${input.sessionID}`,
        sql`${SessionMessageTable.id} = ${input.assistantMessageID}`,
      ),
    )
    .get()
    .pipe(Effect.orDie)
  const data: unknown = current?.data
  const content = record(data) ? data.content : undefined
  const part = Array.isArray(content)
    ? content.findLast((part) => record(part) && part.type === "tool" && part.id === input.callID)
    : undefined
  if (record(part) && typeof part.name === "string") return part.name

  const prior = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, input.sessionID),
        inArray(EventTable.type, ["session.next.tool.input.started.1", "session.next.tool.called.1"]),
        sql`json_extract(${EventTable.data}, '$.assistantMessageID') = ${input.assistantMessageID}`,
        sql`json_extract(${EventTable.data}, '$.callID') = ${input.callID}`,
      ),
    )
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const tool = prior?.data.tool ?? prior?.data.name
  if (typeof tool === "string") return tool
  const imported = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, input.sessionID),
        eq(EventTable.type, "session.next.message.imported.1"),
        sql`json_extract(${EventTable.data}, '$.message.id') = ${input.assistantMessageID}`,
      ),
    )
    .orderBy(desc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  for (const row of imported) {
    const message = row.data.message
    if (!record(message) || !Array.isArray(message.content)) continue
    const part = message.content.findLast((part) => record(part) && part.type === "tool" && part.id === input.callID)
    if (record(part) && typeof part.name === "string") return part.name
  }
})

/** Redact outbound event envelopes; exact-retry comparison preserves unknown tools instead of guessing. */
export const strip = <T>(
  payload: T,
  database?: Database.Interface,
  options?: { unknown?: "strip" | "preserve" },
): Effect.Effect<T> => {
  const names = new Map<string, string>()
  const key = (sessionID: string, messageID: string, callID: string) => JSON.stringify([sessionID, messageID, callID])
  const remember = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(remember)
    if (!record(value)) return
    const data = record(value.data) ? value.data : record(value.properties) ? value.properties : undefined
    if (data && typeof data.sessionID === "string") {
      if (
        typeof value.type === "string" &&
        /^session\.next\.tool\.(?:input\.started|called)(?:\.\d+)?$/.test(value.type) &&
        typeof data.assistantMessageID === "string" &&
        typeof data.callID === "string"
      ) {
        const tool = data.tool ?? data.name
        if (typeof tool === "string") names.set(key(data.sessionID, data.assistantMessageID, data.callID), tool)
      }
      const message = data.message
      if (record(message) && typeof message.id === "string" && Array.isArray(message.content))
        for (const part of message.content)
          if (record(part) && part.type === "tool" && typeof part.id === "string" && typeof part.name === "string")
            names.set(key(data.sessionID, message.id, part.id), part.name)
    }
    Object.values(value).forEach(remember)
  }
  remember(payload)
  const visit = (value: unknown): Effect.Effect<unknown> =>
    Effect.gen(function* () {
      if (Array.isArray(value)) return yield* Effect.forEach(value, visit)
      if (!record(value)) return value
      const type = typeof value.type === "string" ? value.type.replace(/\.\d+$/, "") : undefined
      const field = record(value.data) ? "data" : record(value.properties) ? "properties" : undefined
      const data = field ? value[field] : undefined
      if (
        type &&
        ["session.next.tool.progress", "session.next.tool.success", "session.next.tool.failed"].includes(type) &&
        record(data)
      ) {
        const sessionID =
          typeof data.sessionID === "string" ? data.sessionID : (value.aggregateID ?? value.aggregate_id)
        const tool =
          typeof sessionID === "string" &&
          typeof data.assistantMessageID === "string" &&
          typeof data.callID === "string"
            ? ((database
                ? yield* name(database, { sessionID, assistantMessageID: data.assistantMessageID, callID: data.callID })
                : undefined) ?? names.get(key(sessionID, data.assistantMessageID, data.callID)))
            : undefined
        if (tool === "computer" || (tool === undefined && options?.unknown !== "preserve")) {
          const clean = ComputerScreenshots.stripResult(data)
          return {
            ...value,
            [field!]:
              record(clean) && "structured" in data && !("structured" in clean) ? { ...clean, structured: {} } : clean,
          }
        }
        return value
      }
      return Object.fromEntries(
        yield* Effect.forEach(Object.entries(value), ([key, item]) =>
          visit(item).pipe(Effect.map((item) => [key, item])),
        ),
      )
    })
  return visit(ComputerScreenshots.stripPayload(payload)) as Effect.Effect<T>
}
