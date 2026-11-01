import { Effect, Schema, Semaphore } from "effect"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import type { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { MessageID, SessionID } from "@/session/schema"
import type { SubagentRecord, SubagentStatus, SubagentUsage } from "@/agent/subagent-kind"
import { isRecord } from "@/util/record"
import { randomUUID } from "node:crypto"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { Task } from "@vectordevai/schema/task"
import { Database } from "@vectordevai/core/database/database"

/*
 * Lifecycle bookkeeping for task-tool subagents.
 *
 * Each child session carries a SubagentRecord at `metadata.subagent`.
 * Session.setMetadata publishes `session.updated`, so the record survives a
 * restart and reaches clients live. The same lifecycle fields are mirrored
 * onto the parent's task tool part, which publishes `message.part.updated`.
 * Nothing here may fail a task, so every helper swallows its own errors, and
 * logs them so a card that stopped updating can still be traced.
 */

/** Key of the lifecycle record in a child session's metadata. */
export const METADATA_KEY = "subagent"
// Observation identity only: this never claims durable or clustered execution ownership.
export const RUNTIME_ID = randomUUID()
// Admission, messaging and Stop share one short critical section; execution runs outside it.
export const controlLock = Semaphore.makeUnsafe(1)
// Stop releases the admission lock while interrupting nested runners; these claims block new work until cleanup ends.
export const stopping = new Set<SessionID>()
// Independent of admission: callers may already hold controlLock. Serialize metadata read/merge/write.
const metadataLock = Semaphore.makeUnsafe(1)

export type FinalStatus = Extract<SubagentStatus, "completed" | "error" | "cancelled">

/** Lifecycle fields that change after launch. In a patch, `undefined` clears the field. */
export type Outcome = Partial<Pick<SubagentRecord, "status" | "completedAt" | "usage" | "error">>

// A background launch's part is completed right after the launch returns, and
// a foreground part turns to error as soon as the call fails, so the first
// polls are quick. The part can stay pending far longer, though: a sibling tool
// in the same step still running, an unanswered permission prompt, a provider
// retry backoff. So polling slows down and keeps going for ten minutes.
const PART_QUICK_ATTEMPTS = 50
const PART_QUICK_RETRY = "200 millis"
const PART_SLOW_ATTEMPTS = 120
const PART_SLOW_RETRY = "5 seconds"

export function read(info: Pick<Session.Info, "metadata">): SubagentRecord | undefined {
  const value = info.metadata?.[METADATA_KEY]
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.agent !== "string" ||
    typeof value.parentSessionID !== "string" || typeof value.parentMessageID !== "string" ||
    typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) ||
    !["queued", "running", "completed", "error", "cancelled"].includes(String(value.status)) ||
    !isRecord(value.model) || typeof value.model.providerID !== "string" || typeof value.model.modelID !== "string") return undefined
  const strings = (input: unknown) => Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : undefined
  const optionalString = (input: unknown) => typeof input === "string" ? input : undefined
  const budget = Schema.decodeUnknownOption(RunBudget.Info)(value.budget)
  const scopes = Schema.decodeUnknownOption(Schema.Array(Task.BudgetScope))(value.budgetScopes)
  return {
    ...value,
    ownedPaths: strings(value.ownedPaths), dependsOn: strings(value.dependsOn), successCriteria: strings(value.successCriteria),
    batchID: optionalString(value.batchID), resultRef: optionalString(value.resultRef), resultSummary: optionalString(value.resultSummary),
    reason: optionalString(value.reason), error: optionalString(value.error),
    completedAt: typeof value.completedAt === "number" && Number.isFinite(value.completedAt) ? value.completedAt : undefined,
    attempt: typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt > 0 ? value.attempt : undefined,
    budget: budget._tag === "Some" ? budget.value : undefined,
    budgetScopes: scopes._tag === "Some" ? scopes.value : undefined,
    notification: isRecord(value.notification) && typeof value.notification.text === "string" && typeof value.notification.launchID === "string" && ["completed", "error", "cancelled"].includes(String(value.notification.state))
      ? { ...value.notification, messageID: optionalString(value.notification.messageID) } : undefined,
    mailbox: Array.isArray(value.mailbox) ? value.mailbox.filter((item) => isRecord(item) && typeof item.id === "string" && typeof item.sender === "string" && typeof item.text === "string" && ["steer", "queue"].includes(String(item.delivery)) && typeof item.createdAt === "number" && Number.isFinite(item.createdAt)) : undefined,
  } as SubagentRecord
}

/** Shallow merge in which an `undefined` patch value removes the key. */
export function merge(base: Record<string, unknown> | undefined, patch: object) {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

/** Drops keys whose value is `undefined`. */
export function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as Partial<T>
}

/** Merges a patch into the child's record. setMetadata replaces the whole metadata object, so this reads first. */
export function write(sessions: Session.Interface, sessionID: SessionID, patch: Partial<SubagentRecord>, attempt?: number) {
  return Effect.gen(function* () {
    const info = yield* sessions.get(sessionID)
    if (attempt !== undefined && read(info)?.attempt !== attempt) return
    yield* sessions.setMetadata({
      sessionID,
      metadata: { ...info.metadata, [METADATA_KEY]: merge(read(info), patch) },
    })
  }).pipe(metadataLock.withPermits(1))
}

export function update(sessions: Session.Interface, sessionID: SessionID, patch: Partial<SubagentRecord>, attempt?: number) {
  return write(sessions, sessionID, patch, attempt).pipe(
    Effect.catchCause((cause) => Effect.logWarning("subagent lifecycle update failed", { sessionID, cause })),
    Effect.withSpan("SubagentLifecycle.update"),
  )
}

/** Recover undelivered reports only into a human's next prompt, never into a paid retry after a crash. */
export function recover(sessions: Session.Interface, database: Database.Interface, parentID: SessionID, messageID: MessageID) {
  return Effect.gen(function* () {
    const children = (yield* sessions.children(parentID)).filter((child) => !child.internal)
    return (yield* Effect.forEach(children, (child) => Effect.gen(function* () {
      const record = read(child)
      const note = record?.notification
      if (!note || record.runtimeID === RUNTIME_ID) return []
      const exists = (id: string) => MessageV2.get({ sessionID: parentID, messageID: id as MessageID }).pipe(
        Effect.provideService(Database.Service, database), Effect.option,
      )
      if ((yield* exists(note.launchID))._tag === "None") {
        yield* write(sessions, child.id, { notification: undefined }, record.attempt)
        return []
      }
      if (note.messageID && (yield* exists(note.messageID))._tag === "Some") return []
      yield* write(sessions, child.id, { notification: { ...note, messageID } }, record.attempt)
      return [{ type: "text" as const, synthetic: true, text: note.text, metadata: { taskNotification: { taskID: child.id, state: note.state, recovered: true } } }]
    }))).flat()
  })
}

/** How a run ended, read from the error its last assistant message carries; undefined when it did not fail. */
export function failure(
  error: SessionV1.Assistant["error"],
): { status: "error" | "cancelled"; error?: string } | undefined {
  if (!error) return undefined
  if (error.name === "MessageAbortedError") return { status: "cancelled" }
  const data: unknown = (error as { data?: unknown }).data
  const message = isRecord(data) && typeof data.message === "string" && data.message ? data.message : undefined
  return { status: "error", error: message ?? error.name }
}

/**
 * The child's usage: the session row's cost and tokens, which the session
 * projector sums from every step-finish part, plus tool and step counts. Also
 * returns the error the last assistant message ended with, if any.
 */
export function observe(sessions: Session.Interface, sessionID: SessionID) {
  return Effect.gen(function* () {
    const info = yield* sessions.get(sessionID)
    const messages = yield* sessions.messages({ sessionID })
    let toolUses = 0
    let steps = 0
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "tool") toolUses += 1
        if (part.type === "step-finish") steps += 1
      }
    }
    const tokens = {
      input: info.tokens?.input ?? 0,
      output: info.tokens?.output ?? 0,
      reasoning: info.tokens?.reasoning ?? 0,
      cache: { read: info.tokens?.cache.read ?? 0, write: info.tokens?.cache.write ?? 0 },
    }
    const usage: SubagentUsage = {
      tokensOwnOnly: info.tokensOwnOnly === true,
      cost: info.cost ?? 0,
      tokens,
      total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
      toolUses,
      steps,
      unpricedSteps: info.unpricedSteps,
      codiumSteps: info.codiumSteps,
    }
    const last = messages.findLast((message) => message.info.role === "assistant")
    return { usage, failure: last?.info.role === "assistant" ? failure(last.info.error) : undefined }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("subagent usage could not be read", { sessionID, cause }).pipe(Effect.as(undefined)),
    ),
  )
}

/**
 * Final lifecycle fields for a run whose job ended with `input.status`. A job
 * that completed while the child's last assistant message carries an error is
 * recorded as error, or as cancelled when that error is an abort.
 */
export function outcome(
  sessions: Session.Interface,
  sessionID: SessionID,
  input: { status: FinalStatus; error?: string },
) {
  return observe(sessions, sessionID).pipe(
    Effect.map((observed) => {
      const final = input.status === "completed" && observed?.failure ? observed.failure : input
      return {
        status: final.status,
        completedAt: Date.now(),
        usage: observed?.usage,
        error: final.error,
      } satisfies Outcome
    }),
  )
}

/** Writes the final lifecycle fields onto the child's record and returns them. */
export function settle(
  sessions: Session.Interface,
  sessionID: SessionID,
  input: { status: FinalStatus; error?: string },
) {
  return outcome(sessions, sessionID, input).pipe(Effect.tap((value) => update(sessions, sessionID, value)))
}

/**
 * Merges `patch` into the metadata of the parent's task tool part, found by
 * message and call id, and publishes message.part.updated. The processor
 * writes the tool's returned metadata when it settles the call, so a part
 * that is still pending or running is retried briefly instead of patched. A
 * part that does not exist (a caller without a processor) is skipped. A
 * function `patch` is read when the write lands, so it carries the latest state.
 */
export function patchPart(input: {
  sessions: Session.Interface
  messageID: MessageID
  callID: string
  patch: object | (() => object)
}) {
  const attempt = Effect.gen(function* () {
    const part = (yield* MessageV2.parts(input.messageID)).find(
      (item): item is SessionV1.ToolPart => item.type === "tool" && item.callID === input.callID,
    )
    if (!part) return "missing" as const
    if (part.state.status !== "completed" && part.state.status !== "error") return "pending" as const
    const patch = typeof input.patch === "function" ? input.patch() : input.patch
    yield* input.sessions.updatePart({
      ...part,
      state: { ...part.state, metadata: merge(part.state.metadata, patch) },
    })
    return "done" as const
  })
  return Effect.gen(function* () {
    for (let index = 0; index < PART_QUICK_ATTEMPTS + PART_SLOW_ATTEMPTS; index++) {
      if ((yield* attempt) !== "pending") return
      yield* Effect.sleep(index < PART_QUICK_ATTEMPTS ? PART_QUICK_RETRY : PART_SLOW_RETRY)
    }
    yield* Effect.logWarning("subagent tool part never settled; its card keeps its last status", {
      messageID: input.messageID,
      callID: input.callID,
    })
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("subagent tool part patch failed", { messageID: input.messageID, callID: input.callID, cause }),
    ),
    Effect.withSpan("SubagentLifecycle.patchPart"),
  )
}

export * as SubagentLifecycle from "./subagent-lifecycle"
