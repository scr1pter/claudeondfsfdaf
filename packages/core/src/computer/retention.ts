export * as ComputerRetention from "./retention"

import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { PartTable, SessionMessageTable } from "../session/sql"
import { ComputerScreenshots } from "../util/computer-screenshots"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function removed(state: unknown, field: "metadata" | "structured") {
  return record(record(state)?.[field])?.screenshotRemoved === true
}

function tombstone(part: Record<string, unknown>, field: "metadata" | "structured") {
  const state = record(part.state)
  if (!state || state.status === "pending") return part
  const projected = ComputerScreenshots.stripPayload(part)
  return {
    ...projected,
    state: {
      ...record(projected.state),
      [field]: { ...record(record(projected.state)?.[field]), screenshotRemoved: true },
    },
  }
}

const nativeRemoved = Effect.fn("ComputerRetention.nativeRemoved")(function* (
  db: Database.Interface["db"],
  sessionID: string,
  messageID: string,
  callID: string,
) {
  const row = yield* db
    .select({ data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(and(sql`${SessionMessageTable.id} = ${messageID}`, sql`${SessionMessageTable.session_id} = ${sessionID}`))
    .get()
    .pipe(Effect.orDie)
  const content = record(row?.data)?.content
  const part = Array.isArray(content)
    ? content.map(record).findLast((item) => item?.type === "tool" && item.id === callID)
    : undefined
  if (part && part.name !== "computer") return false
  if (part && removed(part.state, "structured")) return true

  // Historical tombstones survive a later part/message deletion or a stale pending-state write.
  const historical = yield* db
    .select({ id: EventTable.id })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, sessionID),
        sql`(
          (${EventTable.type} in ('session.next.tool.progress.1', 'session.next.tool.success.1')
            and json_extract(${EventTable.data}, '$.assistantMessageID') = ${messageID}
            and json_extract(${EventTable.data}, '$.callID') = ${callID}
            and json_extract(${EventTable.data}, '$.structured.screenshotRemoved') = 1)
          or (${EventTable.type} = 'session.next.message.imported.1'
            and json_extract(${EventTable.data}, '$.message.id') = ${messageID}
            and exists (
              select 1 from json_each(${EventTable.data}, '$.message.content') as tool
              where json_extract(tool.value, '$.type') = 'tool'
                and json_extract(tool.value, '$.name') = 'computer'
                and json_extract(tool.value, '$.id') = ${callID}
                and json_extract(tool.value, '$.state.structured.screenshotRemoved') = 1
            ))
        )`,
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return historical !== undefined
})

/** Must run inside the event's write transaction, before encoding, projection, or subscriber notification. */
export const normalize = Effect.fn("ComputerRetention.normalize")(function* (
  db: Database.Interface["db"],
  type: string,
  data: Record<string, unknown>,
) {
  if (typeof data.sessionID !== "string") return data
  if (type === "message.part.updated") {
    const part = record(data.part)
    if (part?.type !== "tool" || part.tool !== "computer" || typeof part.id !== "string") return data
    if (removed(part.state, "metadata")) return { ...data, part: tombstone(part, "metadata") }
    const current = yield* db
      .select({ data: PartTable.data })
      .from(PartTable)
      .where(and(sql`${PartTable.id} = ${part.id}`, sql`${PartTable.session_id} = ${data.sessionID}`))
      .get()
      .pipe(Effect.orDie)
    if (removed(record(current?.data)?.state, "metadata")) return { ...data, part: tombstone(part, "metadata") }
    const historical = yield* db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, data.sessionID),
          eq(EventTable.type, "message.part.updated.1"),
          sql`json_extract(${EventTable.data}, '$.part.id') = ${part.id}`,
          sql`json_extract(${EventTable.data}, '$.part.state.metadata.screenshotRemoved') = 1`,
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    return historical ? { ...data, part: tombstone(part, "metadata") } : data
  }

  if (type === "session.next.message.imported") {
    const message = record(data.message)
    if (message?.type !== "assistant" || typeof message.id !== "string" || !Array.isArray(message.content)) return data
    const sessionID = data.sessionID
    const messageID = message.id
    const content = yield* Effect.forEach(message.content, (item: unknown) =>
      Effect.gen(function* () {
        const part = record(item)
        if (part?.type !== "tool" || part.name !== "computer" || typeof part.id !== "string") return item
        return removed(part.state, "structured") || (yield* nativeRemoved(db, sessionID, messageID, part.id))
          ? tombstone(part, "structured")
          : item
      }),
    )
    return { ...data, message: { ...message, content } }
  }

  if (
    !["session.next.tool.progress", "session.next.tool.success", "session.next.tool.failed"].includes(type) ||
    typeof data.assistantMessageID !== "string" ||
    typeof data.callID !== "string"
  )
    return data
  if (
    record(data.structured)?.screenshotRemoved !== true &&
    !(yield* nativeRemoved(db, data.sessionID, data.assistantMessageID, data.callID))
  )
    return data
  const result = {
    ...data,
    ...(Array.isArray(data.content) ? { content: ComputerScreenshots.stripResult(data.content) } : {}),
    ...(Object.hasOwn(data, "result") ? { result: ComputerScreenshots.stripResult(data.result) } : {}),
  }
  return type === "session.next.tool.failed"
    ? result
    : {
        ...result,
        structured: { ...record(ComputerScreenshots.stripResult(data.structured)), screenshotRemoved: true },
      }
})
