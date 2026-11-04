import type { FollowupDraft } from "@/components/prompt-input/submit"

/*
 * The desktop follow-up queue as data (5.I.1). Messages queued while Vector works wait here, one queue per server and
 * session, and the drainer (followup-queue.tsx) sends the head of a queue when nextToSend says the session can take it.
 * Everything in this file is pure: the store persists what these functions return, and the tests drive them directly.
 */

/** Queued messages one session may hold. */
export const SESSION_LIMIT = 20
/** Queued messages one server may hold across its sessions. */
export const SERVER_LIMIT = 200
/** Attachment bytes (pasted images) one session's queue may hold. */
export const ATTACHMENT_LIMIT = 8 * 1024 * 1024

/** Recorded inside the write lock just before a send, so a reload resends with the same ID or drops a delivered one. */
export type FollowupClaim = { messageID: string; claimedAt: number }

export type FollowupItem = FollowupDraft & { id: string; claim?: FollowupClaim }

/** Why a queue stopped sending: the last run hit a spend stop, was stopped, or ended in another error. */
export type PauseReason = "budget" | "aborted" | "error"

export type FollowupQueue = {
  items: FollowupItem[]
  /** The item whose send failed. The queue holds at it until it is retried or removed. */
  failed?: string
  /** Set when the queue stopped sending, until the user resumes it (I7). */
  paused?: { reason: PauseReason; at: number }
  /** The assistant message whose ending the user accepted by resuming: its error no longer holds the queue. */
  resumed?: string
}

/** How the session's last run ended, read from its last assistant message. */
export type LastRun = { id?: string; ended: "ok" | PauseReason }

export type FollowupGate = {
  busy: boolean
  /** A permission or question waits on the user. */
  blocked: boolean
  /** The session is a subagent's: its parent talks to it, the queue never does. */
  child: boolean
  /** A send for this session is already on its way. */
  sending: boolean
  lastRun: LastRun
}

export type Hold = "empty" | "child" | "sending" | "busy" | "blocked" | "paused" | "failed"

export type NextStep =
  | { send: FollowupItem }
  | { hold: Hold }
  /** The last run ended badly and nobody resumed: the caller pauses the queue with this reason and says so. */
  | { hold: "ended"; reason: PauseReason }

export type Refusal = "session" | "server" | "attachments"

/**
 * What the drainer may send now. The gate holds on busy, blocked, a child session, a send in flight, a paused queue,
 * a failed head, or a last run that did not end "ok" (unless the user resumed after that run).
 */
export function nextToSend(queue: FollowupQueue | undefined, gate: FollowupGate): NextStep {
  const head = queue?.items[0]
  if (!queue || !head) return { hold: "empty" }
  if (gate.child) return { hold: "child" }
  if (gate.sending) return { hold: "sending" }
  if (gate.busy) return { hold: "busy" }
  if (gate.blocked) return { hold: "blocked" }
  if (queue.paused) return { hold: "paused" }
  if (queue.failed === head.id) return { hold: "failed" }
  if (gate.lastRun.ended !== "ok" && (gate.lastRun.id === undefined || gate.lastRun.id !== queue.resumed))
    return { hold: "ended", reason: gate.lastRun.ended }
  return { send: head }
}

type MessageLike = { id: string; role: string; error?: { name?: string } | null }

/** How the last run ended: a BudgetStopError, a MessageAbortedError or any other error on the last assistant message. */
export function lastRunEnded(messages: readonly MessageLike[] | undefined): LastRun {
  if (!messages) return { ended: "ok" }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== "assistant") continue
    const name = message.error?.name
    if (!message.error) return { id: message.id, ended: "ok" }
    if (name === "BudgetStopError") return { id: message.id, ended: "budget" }
    if (name === "MessageAbortedError") return { id: message.id, ended: "aborted" }
    return { id: message.id, ended: "error" }
  }
  return { ended: "ok" }
}

/** The bytes a draft's attachments take as they are stored: pasted images and any file carried as a data URL. */
export function attachmentBytes(items: readonly Pick<FollowupItem, "prompt">[]) {
  let total = 0
  for (const item of items)
    for (const part of item.prompt) {
      if (part.type === "image") total += part.dataUrl.length
      if (part.type === "file" && part.url?.startsWith("data:")) total += part.url.length
    }
  return total
}

/** Items queued across a server's sessions, given each session's count. */
export function serverTotal(counts: Record<string, number> | undefined) {
  let total = 0
  for (const count of Object.values(counts ?? {})) total += count
  return total
}

/**
 * Adds an item behind the others. `total` counts the server's queued items, this session's included. A queue at 20,
 * a server at 200 or attachments past 8 MB refuse it.
 */
export function enqueue(
  queue: FollowupQueue | undefined,
  item: FollowupItem,
  total: number,
): { queue: FollowupQueue } | { refused: Refusal } {
  const items = queue?.items ?? []
  if (items.length >= SESSION_LIMIT) return { refused: "session" }
  if (total >= SERVER_LIMIT) return { refused: "server" }
  if (attachmentBytes([...items, item]) > ATTACHMENT_LIMIT) return { refused: "attachments" }
  return { queue: { ...(queue ?? {}), items: [...items, item] } }
}

const settle = (queue: FollowupQueue): FollowupQueue | undefined => (queue.items.length === 0 ? undefined : queue)

/** Removes an item. An emptied queue is gone, with its pause and failure. */
export function remove(queue: FollowupQueue | undefined, id: string): FollowupQueue | undefined {
  if (!queue) return
  const items = queue.items.filter((item) => item.id !== id)
  if (items.length === queue.items.length) return queue
  return settle({ ...queue, items, failed: queue.failed === id ? undefined : queue.failed })
}

/** Marks an item failed. Its claim stays, so a retry first checks whether the engine already has the message. */
export function markFailed(queue: FollowupQueue | undefined, id: string): FollowupQueue | undefined {
  if (!queue?.items.some((item) => item.id === id)) return queue
  return { ...queue, failed: id }
}

export function pause(queue: FollowupQueue | undefined, reason: PauseReason, at: number): FollowupQueue | undefined {
  if (!queue) return
  return { ...queue, paused: { reason, at } }
}

/** The user resumes the queue, accepting how `lastRunID` ended. A failed head still waits for its own Retry. */
export function resume(queue: FollowupQueue | undefined, lastRunID?: string): FollowupQueue | undefined {
  if (!queue) return
  const { paused: _, ...rest } = queue
  return lastRunID ? { ...rest, resumed: lastRunID } : rest
}

/** A send the user asked for (Send now, Retry): it clears the pause and the failure first. */
export function retry(queue: FollowupQueue | undefined, lastRunID?: string): FollowupQueue | undefined {
  const next = resume(queue, lastRunID)
  if (!next) return
  const { failed: _, ...rest } = next
  return rest
}

export function claim(
  queue: FollowupQueue | undefined,
  id: string,
  messageID: string,
  claimedAt: number,
): FollowupQueue | undefined {
  if (!queue) return
  return {
    ...queue,
    items: queue.items.map((item) => (item.id === id ? { ...item, claim: { messageID, claimedAt } } : item)),
  }
}

/** Drops a claim whose send never went out. */
export function release(queue: FollowupQueue | undefined, id: string): FollowupQueue | undefined {
  if (!queue) return
  return {
    ...queue,
    items: queue.items.map((item) => {
      if (item.id !== id || !item.claim) return item
      const { claim: _, ...rest } = item
      return rest
    }),
  }
}

/** Servers that have at least one queued item. */
export function serversWithItems(
  queues: Record<string, Record<string, FollowupQueue | undefined> | undefined>,
): string[] {
  return Object.entries(queues)
    .filter(([, sessions]) => Object.values(sessions ?? {}).some((queue) => (queue?.items.length ?? 0) > 0))
    .map(([server]) => server)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

function parseItem(value: unknown): FollowupItem | undefined {
  if (!isRecord(value)) return
  if (typeof value.id !== "string" || typeof value.sessionID !== "string") return
  if (typeof value.sessionDirectory !== "string" || !Array.isArray(value.prompt)) return
  if (typeof value.agent !== "string" || !isRecord(value.model)) return
  const claimValue = value.claim
  const valid =
    isRecord(claimValue) && typeof claimValue.messageID === "string" && typeof claimValue.claimedAt === "number"
  const item = { ...value, context: Array.isArray(value.context) ? value.context : [] } as FollowupItem
  if (!valid) delete item.claim
  return item
}

const PAUSE_REASONS = new Set<string>(["budget", "aborted", "error"])

/** Reads a stored queue, dropping what does not parse. */
export function parseQueue(value: unknown): FollowupQueue | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return
  const items = value.items.map(parseItem).filter((item): item is FollowupItem => !!item)
  if (items.length === 0) return
  const queue: FollowupQueue = { items }
  if (typeof value.failed === "string" && items.some((item) => item.id === value.failed)) queue.failed = value.failed
  const paused = value.paused
  if (isRecord(paused) && typeof paused.reason === "string" && PAUSE_REASONS.has(paused.reason))
    queue.paused = { reason: paused.reason as PauseReason, at: typeof paused.at === "number" ? paused.at : 0 }
  if (typeof value.resumed === "string") queue.resumed = value.resumed
  return queue
}

/**
 * The per-session queues an older page kept under `followup.v1` (`{items, failed, paused}` keyed by session). Each item
 * was queued mid-session, so it is marked replied; a paused session was paused by Stop.
 */
export function legacyQueues(value: unknown): Record<string, FollowupQueue> {
  if (!isRecord(value) || !isRecord(value.items)) return {}
  const failed = isRecord(value.failed) ? value.failed : {}
  const paused = isRecord(value.paused) ? value.paused : {}
  const result: Record<string, FollowupQueue> = {}
  for (const [sessionID, list] of Object.entries(value.items)) {
    const queue = parseQueue({ items: Array.isArray(list) ? list : [], failed: failed[sessionID] })
    if (!queue) continue
    queue.items = queue.items
      .filter((item) => item.sessionID === sessionID)
      .map((item) => ({ ...item, replied: true as const }))
    if (queue.items.length === 0) continue
    if (paused[sessionID] === true) queue.paused = { reason: "aborted", at: 0 }
    result[sessionID] = queue
  }
  return result
}

/**
 * Moves a legacy queue into the current one: items not already there go behind it, up to the session and server limits
 * (`total` counts the server's items before adopting, this session's included). A legacy pause or failure carries over.
 */
export function adopt(current: FollowupQueue | undefined, legacy: FollowupQueue, total: number) {
  const items = [...(current?.items ?? [])]
  const known = new Set(items.map((item) => item.id))
  let room = Math.min(SESSION_LIMIT - items.length, SERVER_LIMIT - total)
  for (const item of legacy.items) {
    if (room <= 0) break
    if (known.has(item.id)) continue
    items.push(item)
    known.add(item.id)
    room--
  }
  if (items.length === 0) return
  const queue: FollowupQueue = { ...(current ?? {}), items }
  if (!queue.paused && legacy.paused) queue.paused = legacy.paused
  if (!queue.failed && legacy.failed && known.has(legacy.failed)) queue.failed = legacy.failed
  return queue
}

/** The first non-empty line a queued draft shows in the dock; undefined for attachments alone. */
export function previewText(prompt: FollowupDraft["prompt"]) {
  return prompt
    .map((part) => {
      if (part.type === "image") return `[image:${part.filename}]`
      if (part.type === "file") return `[file:${part.path}]`
      if (part.type === "agent") return `@${part.name}`
      return part.content
    })
    .join("")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => !!line)
}
