import { ComputerScreenshots } from "@vectordevai/core/util/computer-screenshots"

export * as ComputerScreenshotHistory from "./screenshot-history"

/**
 * One deletion the engine finished (E13's prune route, called by desktop main on the retention schedule, at the end of
 * a task and for Delete all). It is the route's own selection: every screenshot, or those taken before a time, in one
 * conversation, or both. The prune route never republishes the parts it changed, so every client holding history
 * applies the same change to its copy and refetches (D23).
 */
export type Removal = { all: true } | { before: number; sessionID?: string } | { before?: number; sessionID: string }

/** Desktop main's event to Vector's own renderer windows after a deletion. */
export const CHANNEL = "computer-screenshots-removed"

const MEDIA = new Set(["file", "image", "image-data", "image-url", "media"])
const SESSION = /^[A-Za-z0-9_-]{1,128}$/
const DEPTH = 64

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Accepts `all: true` alone, or a cutoff and/or a conversation, and nothing else: a malformed message changes nothing. */
export function decode(value: unknown): Removal | undefined {
  if (!record(value)) return
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === "all") return value.all === true ? { all: true } : undefined
  if (keys.length === 0 || keys.some((key) => key !== "before" && key !== "sessionID")) return
  const before = value.before
  const sessionID = value.sessionID
  if (before !== undefined && !(typeof before === "number" && Number.isFinite(before) && before >= 0)) return
  if (sessionID !== undefined && !(typeof sessionID === "string" && SESSION.test(sessionID))) return
  if (sessionID !== undefined) return before === undefined ? { sessionID } : { before, sessionID }
  if (before !== undefined) return { before }
}

/**
 * Whether a tool state still carries screenshot media, by the engine's own test: an `attachments` or `screenshots`
 * field, or a file or image node, anywhere in it. An unreadably deep value counts as media, so it is removed.
 */
export function hasMedia(value: unknown, depth = 0): boolean {
  if (depth > DEPTH) return true
  if (Array.isArray(value)) return value.some((item) => hasMedia(item, depth + 1))
  if (!record(value)) return false
  if (MEDIA.has(String(value.type))) return true
  for (const [key, item] of Object.entries(value)) {
    if (key === "attachments" || key === "screenshots") return true
    if (hasMedia(item, depth + 1)) return true
  }
  return false
}

type PartLike = { type: string; sessionID?: string }

/** A V1 `computer` tool part whose screenshots this deletion removed. `created` is its message's creation time. */
export function removes(part: PartLike, removal: Removal, created?: number): boolean {
  const value = part as PartLike & { tool?: unknown; state?: unknown }
  if (value.type !== "tool" || value.tool !== "computer" || !record(value.state)) return false
  if (!hasMedia(value.state)) return false
  if ("all" in removal) return true
  if (removal.sessionID !== undefined && value.sessionID !== removal.sessionID) return false
  if (removal.before === undefined) return true
  // The engine dates a part by when its call ended, else by its message. With neither, it is removed: the refetch
  // that follows restores anything the engine kept.
  const time = record(value.state.time) ? value.state.time.end : undefined
  const at = typeof time === "number" && Number.isFinite(time) ? time : created
  return at === undefined || at < removal.before
}

/**
 * The part as the engine stored it after the deletion (E13's tombstone): every media copy gone, the rest of its state
 * kept, and `metadata.screenshotRemoved` set, so the timeline shows "Screenshot removed" rather than nothing.
 */
export function tombstone<T extends PartLike>(part: T): T {
  const value = part as T & { state?: unknown }
  const stripped = ComputerScreenshots.stripResult(value.state)
  const state = record(stripped) ? stripped : {}
  const metadata = record(state.metadata) ? state.metadata : {}
  return { ...value, state: { ...state, metadata: { ...metadata, screenshotRemoved: true } } }
}

/** A page of parts fetched before deletions finished, with what those deletions removed taken out. */
export function apply<T extends PartLike>(parts: readonly T[], removals: readonly Removal[], created?: number): T[] {
  return parts.map((part) => (removals.some((removal) => removes(part, removal, created)) ? tombstone(part) : part))
}
