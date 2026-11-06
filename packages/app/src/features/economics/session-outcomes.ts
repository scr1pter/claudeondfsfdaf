// Records a model outcome when an ordinary session finishes.
//
// The engine originally learned only from parallel-workspace runs that ran
// validation, which is a small fraction of real use — so it never accumulated
// enough samples to recommend anything and the feature appeared dead. Ordinary
// sessions carry the same evidence that matters: which model ran, what it
// actually cost, how long it took, and how many files it touched.

import { categorizeTask } from "./task-categorizer"
import { measureUsage, totalSessionCost, type SessionSpend, type UsageBearingMessage } from "./token-usage"
import type { MeasuredLatency, ModelOutcome } from "./economics-types"

type MessageEntry = {
  info?: UsageBearingMessage & {
    id?: string
    role?: string
    time?: { created?: number; completed?: number }
    finish?: string
    error?: { name?: string }
    structured?: unknown
  }
}
type PartEntry = { type?: string; tool?: string; state?: { input?: Record<string, unknown> } }

export function measureReplyTime(
  messages: readonly Pick<NonNullable<MessageEntry["info"]>, "role" | "forked" | "time">[],
): MeasuredLatency | undefined {
  const replies = messages.filter((message) => message.role === "assistant" && !message.forked)
  if (!replies.length) return undefined
  const durations = replies
    .map((reply) => {
      const started = reply.time?.created
      const finished = reply.time?.completed
      if (typeof started !== "number" || typeof finished !== "number") return undefined
      if (!Number.isFinite(started) || !Number.isFinite(finished) || started < 0 || finished < started) return undefined
      return finished - started
    })
    .filter((duration): duration is number => duration !== undefined)
  // An earlier unfinished attempt still belongs to the cumulative task; its missing duration is not zero.
  if (durations.length !== replies.length) return undefined
  const latencyMs = durations.reduce((total, duration) => total + duration, 0)
  return Number.isFinite(latencyMs) ? { latencyMs, latencyKind: "assistant-reply-sum" } : undefined
}

// Bind parallel-workspace evidence to one durable snapshot, just as the ordinary-session recorder does.
export async function measureSessionEconomics(input: {
  session: () => Promise<(SessionSpend & { time?: { updated?: number } }) | undefined>
  messages: () => Promise<readonly NonNullable<MessageEntry["info"]>[] | undefined>
}) {
  const before = await input.session()
  const updatedAt = before?.time?.updated
  if (!before || typeof updatedAt !== "number" || !Number.isFinite(updatedAt))
    throw new Error("Session metadata is unavailable")
  const messages = await input.messages()
  if (!messages) throw new Error("Session history is unavailable")
  const after = await input.session()
  if (
    !after ||
    after.time?.updated !== updatedAt ||
    after.cost !== before.cost ||
    after.unpricedSteps !== before.unpricedSteps ||
    after.subagentCost !== before.subagentCost ||
    after.subagentUnpricedSteps !== before.subagentUnpricedSteps
  )
    throw new Error("Session changed while collecting usage")
  return { measured: measureUsage(messages), timing: measureReplyTime(messages), spend: after, updatedAt }
}

function firstUserText(parts: Record<string, PartEntry[] | undefined>, messages: MessageEntry[]) {
  for (const message of messages) {
    if (message.info?.role !== "user") continue
    const id = message.info.id
    const text = (parts[id ?? ""] ?? []).find((part) => part.type === "text") as { text?: string } | undefined
    if (text?.text?.trim()) return text.text
  }
  return ""
}

// Distinct file paths any write-like tool touched. Counting tool calls instead
// would inflate the number every time an agent edits one file repeatedly.
function changedFileCount(parts: Record<string, PartEntry[] | undefined>) {
  const files = new Set<string>()
  for (const list of Object.values(parts)) {
    for (const part of list ?? []) {
      if (part.type !== "tool") continue
      if (!["write", "edit", "apply_patch", "patch"].includes(part.tool ?? "")) continue
      const path = part.state?.input?.filePath ?? part.state?.input?.path
      if (typeof path === "string" && path) files.add(path)
    }
  }
  return files.size
}

export function outcomeFromSession(input: {
  sessionID: string
  projectId: string
  messages: MessageEntry[]
  parts: Record<string, PartEntry[] | undefined>
  // All observed task spend, including title generation and subagents; token/model attribution stays message-based.
  spend?: SessionSpend
}): ModelOutcome | undefined {
  const infos = input.messages
    .map((entry) => (entry.info ? { ...entry.info, parts: input.parts[entry.info.id ?? ""] } : undefined))
    .filter((info): info is NonNullable<typeof info> => Boolean(info))
  const measured = measureUsage(infos)
  // No reported usage means nothing worth learning from — a session that never
  // reached a provider tells us nothing about that model.
  if (!measured || measured.codium || input.spend?.codiumSteps || input.spend?.subagentCodiumSteps) return undefined

  const costUsd = totalSessionCost(input.spend, measured.costUsd)

  return {
    // Later turns replace the cumulative sample under this same identity.
    id: `session:${input.sessionID}`,
    projectId: input.projectId,
    provider: measured.provider,
    model: measured.model,
    mixedModels: measured.mixedModels,
    variant: measured.variant,
    category: categorizeTask(firstUserText(input.parts, input.messages)),
    createdAt: Date.now(),
    hadChecks: false,
    execution: executionFromMessages(infos),
    ...measureReplyTime(infos),
    changedFiles: changedFileCount(input.parts),
    usage: measured.usage,
    costUsd,
    // A partial cost is a lower bound: kept for the record, never ranked as what the run cost.
    ...(costUsd !== undefined ? { costPriced: !measured.partial } : {}),
  }
}

function executionFromMessages(infos: NonNullable<MessageEntry["info"]>[]): ModelOutcome["execution"] {
  const latest = infos.findLast((info) => !info.forked && (info.role === "assistant" || info.role === "user"))
  if (!latest || latest.role === "user") return "incomplete"
  if (latest.error?.name === "MessageAbortedError" || latest.finish === "abort") return "aborted"
  if (latest.error || latest.finish === "error" || latest.finish === "content-filter") return "failed"
  if (!Number.isFinite(latest.time?.completed)) return "incomplete"
  if (latest.finish === "stop" || (latest.finish === "tool-calls" && latest.structured !== undefined))
    return "completed"
  return "incomplete"
}

// Idle can be replayed, and another turn can finish while history is being fetched.
// Coalesce those notifications, and let the caller reject a snapshot superseded during its fetch.
export function createSessionOutcomeRecorder(
  record: (sessionID: string, directory: string, current: () => boolean) => Promise<void>,
) {
  const sessions = new Map<
    string,
    { revision: number; recorded?: number; pending?: Promise<void>; requested: boolean; attempts: number }
  >()
  const lifecycle = { disposed: false }
  const state = (sessionID: string, directory: string) => {
    const key = JSON.stringify([directory, sessionID])
    const existing = sessions.get(key)
    if (existing) return existing
    const value = { revision: 0, requested: false, attempts: 0 }
    sessions.set(key, value)
    return sessions.get(key)!
  }
  const recorder = {
    changed(sessionID: string, directory: string, revision: number) {
      if (!Number.isFinite(revision) || lifecycle.disposed) return
      const value = state(sessionID, directory)
      if (revision <= value.revision) return
      value.revision = revision
      value.attempts = 0
      if (value.pending) value.requested = true
    },
    async refresh(sessionID: string, directory: string, revision: number) {
      if (!Number.isFinite(revision) || lifecycle.disposed) return false
      recorder.changed(sessionID, directory, revision)
      const value = state(sessionID, directory)
      // A later settlement notification can retry a failed capture at the same durable revision.
      // Keep each notification bounded and share any in-flight retry batch.
      if (!value.pending) value.attempts = 0
      await recorder.idle(sessionID, directory)
      return !lifecycle.disposed && value.recorded !== undefined && value.recorded >= revision
    },
    idle(sessionID: string, directory: string): Promise<void> {
      if (lifecycle.disposed) return Promise.resolve()
      const value = state(sessionID, directory)
      if (value.pending) {
        value.requested = true
        return value.pending
      }
      if (value.recorded === value.revision || value.attempts >= 3) return Promise.resolve()
      const revision = value.revision
      value.attempts += 1
      value.pending = record(sessionID, directory, () => !lifecycle.disposed && value.revision === revision)
        .then(() => {
          if (value.revision === revision) value.recorded = revision
        })
        .catch(() => {
          // Failed reads or storage writes may be transient; successful no-usage snapshots do not retry.
          if (value.revision === revision && value.attempts < 3) value.requested = true
        })
        .finally(() => {
          value.pending = undefined
          if (!value.requested) return
          value.requested = false
          return recorder.idle(sessionID, directory)
        })
      return value.pending
    },
    dispose() {
      lifecycle.disposed = true
      sessions.clear()
    },
  }
  return recorder
}
