import type { PublicSession } from "@vectordevai/schema/public-session"
import type { SessionV1 } from "@vectordevai/schema/session-v1"
import type { SessionMessage } from "@vectordevai/schema/session-message"
import type { Schema } from "effect"

type Part = Schema.Schema.Type<typeof SessionV1.Part>
type HistoryMessage = Schema.Schema.Type<typeof SessionV1.WithParts>

/** Project computer results without their screenshots; other tools keep their attachments. */
export function stripPart<T extends Part>(part: T): T {
  return stripPayload(part)
}

export function stripHistory<T extends HistoryMessage>(messages: readonly T[]): T[] {
  return messages.map(stripPayload)
}

/** Current sessions can retain the same file in content, attachments and provider result envelopes. */
export function stripNative<T extends SessionMessage.Message>(message: T): T {
  return stripPayload(message)
}

/** Used only after identifying a computer tool: retain text while dropping its media result copies. */
export function stripResult(value: unknown): unknown {
  if (Array.isArray(value))
    return value.flatMap((item) => {
      const next = stripResult(item)
      return next === undefined ? [] : [next]
    })
  if (!record(value)) return value
  if (["file", "image", "image-data", "image-url", "media"].includes(String(value.type))) return undefined
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (key === "attachments" || key === "screenshots") return []
      const next = stripResult(item)
      return next === undefined ? [] : [[key, next]]
    }),
  )
}

/** The portable public transcript stores explicitly opted-in screenshots beside its tool entry. */
export function stripPublic(archive: PublicSession.Archive): PublicSession.Archive {
  return {
    ...archive,
    messages: archive.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== "tool" || !part.screenshots) return part
        const next = { ...part }
        delete next.screenshots
        return next
      }),
    })),
  }
}

/** Project JSON message/event envelopes, including stored V1 parts with IDs outside their data. */
export function stripPayload<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripPayload) as T
  if (!record(value)) return value
  const computer = value.type === "tool" && (value.tool === "computer" || value.name === "computer")
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (computer && key === "screenshots") return []
      if (!computer || key !== "state" || !record(item)) return [[key, stripPayload(item)]]
      const state = stripResult(item) as Record<string, unknown>
      // Tool input and required record fields retain their shape; the projection changes only result media.
      if ("input" in item) state.input = item.input
      for (const field of ["structured", "metadata"]) if (field in item && !(field in state)) state[field] = {}
      return [[key, state]]
    }),
  ) as T
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export * as ComputerScreenshots from "./computer-screenshots"
