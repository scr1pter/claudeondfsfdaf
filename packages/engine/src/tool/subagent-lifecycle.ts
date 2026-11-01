import { and, eq, isNull, sql } from "drizzle-orm"
import { Effect, Option, Schema, Semaphore } from "effect"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import type { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { MessageID, SessionID } from "@/session/schema"
import {
  SUBAGENT_EFFORTS,
  SUBAGENT_INTERRUPTION_CAUSES,
  SUBAGENT_MODEL_SOURCES,
  type SubagentRecord,
  type SubagentStatus,
  type SubagentUsage,
} from "@/agent/subagent-kind"
import { isRecord } from "@/util/record"
import { randomUUID } from "node:crypto"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { Task } from "@vectordevai/schema/task"
import { Database } from "@vectordevai/core/database/database"
import { SessionTable } from "@vectordevai/core/session/sql"
import type { SpendGuard } from "@vectordevai/core/spend-guard"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { BackgroundJob } from "@/background/job"
import { SessionMemory } from "@/session/memory"
import { SessionTaskSize } from "@/session/task-size"
import { WorkflowMarkers } from "@/orchestration/constants"

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
// The runtime ID of a record written without an instance lease; a launch records its lease (BackgroundJobStore.Owner).
export const RUNTIME_ID = randomUUID()
// Admission, messaging and Stop share one short critical section; execution runs outside it. Take it with `locked`, so
// an interrupted caller cannot keep it, and hold it only for in-memory and database steps.
export const controlLock = Semaphore.makeUnsafe(1)
// Stop releases the admission lock while interrupting nested runners; these claims block new work until cleanup ends.
export const stopping = new Set<SessionID>()
// Independent of admission: callers may already hold controlLock. Serialize metadata read/merge/write.
const metadataLock = Semaphore.makeUnsafe(1)
// Read-modify-write of a stored, settled tool part (patchPart, patchEntry, settleOrphanPart).
const partLock = Semaphore.makeUnsafe(1)

export { claims, type Claim } from "@/task/claims"

/** The reason an interrupted helper's record carries. */
export const INTERRUPTED_REASON =
  "Interrupted when Vector stopped (an update, restart or crash); partial work was kept."
/** The error an orphaned launching tool part is settled with. */
export const INTERRUPTED_ERROR = "Interrupted when Vector stopped"
/** The brief a resumed interrupted helper starts from. */
export const RESUME_BRIEF =
  "[vector:resume] Vector stopped while you were working (an update, restart or crash). Your conversation and the files you changed are as you left them; tool calls that were running did not finish. Check the state of your work, then continue your assignment from where you stopped. Do not redo finished steps."
/** The brief a resumed helper the user stopped starts from. */
export const RESUME_STOPPED_BRIEF =
  "[vector:resume] The user stopped you and has now asked you to continue. Check the state of your work, then continue your assignment from where you stopped. Do not redo finished steps."
/** The brief a resumed helper that failed, or that its parent stopped, starts from. */
export const RESUME_ENDED_BRIEF =
  "[vector:resume] Your run ended before you finished, and you are asked to continue. Check the state of your work, then continue your assignment from where you stopped. Do not redo finished steps."

export type FinalStatus = Extract<SubagentStatus, "completed" | "error" | "cancelled">

/** Lifecycle fields that change after launch. In a patch, `undefined` clears the field. */
export type Outcome = Partial<Pick<SubagentRecord, "status" | "completedAt" | "usage" | "error">>

/** Whether the record still describes work in flight: queued or running. */
export function open(record: Pick<SubagentRecord, "status"> | undefined) {
  return record?.status === "queued" || record?.status === "running"
}

/** Whether this process runs or ran the record's work: its runtime ID is this process's own, or one of its leases. */
export function ownedHere(record: Pick<SubagentRecord, "runtimeID">) {
  return record.runtimeID === RUNTIME_ID || record.runtimeID?.startsWith(`${BackgroundJobStore.PROCESS_ID}:`) === true
}

/** How long an older Vector's open helper (a legacy runtime ID, no lease to probe) must be idle to read as gone. */
export const LEGACY_IDLE = 30 * 60_000

/**
 * The liveness of the record's runtime when no job row is needed to tell (D.3): this process's own ID and open lease
 * are alive, a closed lease dead. A legacy runtime ID (no ":") is dead, except open work whose session was `updated`
 * within LEGACY_IDLE: an older Vector may still be running it. Undefined for another process's lease.
 */
export function localLiveness(
  record: Pick<SubagentRecord, "runtimeID" | "status">,
  updated?: number,
): BackgroundJobStore.Liveness | undefined {
  const runtime = record.runtimeID
  if (runtime === RUNTIME_ID) return "alive"
  if (!runtime?.includes(":"))
    return open(record) && updated !== undefined && updated > Date.now() - LEGACY_IDLE ? "unknown" : "dead"
  if (runtime.startsWith(`${BackgroundJobStore.PROCESS_ID}:`))
    return BackgroundJobStore.alive({ runtime, pid: process.pid, boot: 0, machine: "" })
  return undefined
}

/**
 * Whether an engine may still be running the record's work: `localLiveness`, else from the job row of another
 * process's lease, which alone keeps the machine id and the heartbeat. The row is written after the record, so with
 * none the record's owner decides: dead once its pid is gone, or when the record has no owner; unknown otherwise.
 */
export const liveness = Effect.fnUntraced(function* (
  store: BackgroundJobStore.Interface,
  child: Pick<Session.Info, "id" | "time">,
  record: Pick<SubagentRecord, "runtimeID" | "parentSessionID" | "status" | "owner">,
) {
  const local = localLiveness(record, child.time.updated)
  if (local) return local
  const row = (yield* store.forParent(record.parentSessionID)).find(
    (item) => item.id === child.id && item.owner.runtime === record.runtimeID,
  )
  if (row) return BackgroundJobStore.liveness(row)
  return !record.owner || BackgroundJobStore.exited(record.owner.pid) ? ("dead" as const) : ("unknown" as const)
})

/** Whether resuming this helper waits for the user: it was interrupted and not resumed since, or the user stopped it. */
export function needsHuman(record: Pick<SubagentRecord, "interruption" | "stop">) {
  return (
    (record.interruption !== undefined && record.interruption.resumedAt === undefined) || record.stop?.by === "user"
  )
}

/** Why the agent may not resume a helper that `needsHuman` holds for. */
export const HUMAN_FIRST = "Interrupted or user-stopped helpers resume only after the user asks; tell the user."

/**
 * Whether the agent may resume this helper now (D.3): it needs no human, or the root has a message from the user newer
 * than the report of its interruption and the user's stop.
 */
export const agentMayResume = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "findMessage">,
  rootID: SessionID,
  record: Pick<SubagentRecord, "interruption" | "stop">,
) {
  if (!needsHuman(record)) return true
  const interruption = record.interruption?.resumedAt === undefined ? record.interruption : undefined
  const since = Math.max(
    interruption ? (interruption.reportedAt ?? interruption.at) : 0,
    record.stop?.by === "user" ? record.stop.at : 0,
  )
  const latest = yield* sessions
    .findMessage(rootID, SessionTaskSize.real)
    .pipe(Effect.catchCause(() => Effect.succeed(Option.none<SessionV1.WithParts>())))
  return Option.isSome(latest) && latest.value.info.time.created > since
})

// A background launch's part is completed right after the launch returns, and
// a foreground part turns to error as soon as the call fails, so the first
// polls are quick. The part can stay pending far longer, though: a sibling tool
// in the same step still running, an unanswered permission prompt, a provider
// retry backoff. So polling slows down and keeps going for ten minutes.
const PART_QUICK_ATTEMPTS = 50
const PART_QUICK_RETRY = "200 millis"
const PART_SLOW_ATTEMPTS = 120
const PART_SLOW_RETRY = "5 seconds"

// Shapes of the record's optional fields, checked one by one so a malformed field is dropped, never the record.
const Fork = Schema.Struct({
  point: Schema.String,
  callID: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  warm: Schema.optional(Schema.Boolean),
})
const STRUCTURED_SCHEMA_MAX = 16 * 1024
const Structured = Schema.Struct({
  schema: Schema.Record(Schema.String, Schema.Unknown),
  schemaHash: Schema.String,
  attempts: Schema.Finite,
  valid: Schema.optional(Schema.Boolean),
})
const DelegatedScope = Schema.Struct({
  id: Schema.String,
  budget: RunBudget.Info,
  spentUsd: Schema.Finite,
  steps: Schema.Finite,
  unpricedSteps: Schema.Finite,
  codiumSteps: Schema.optional(Schema.Finite),
  stopped: Schema.optional(Schema.Struct({ reason: Schema.String, message: Schema.String })),
})
const Owner = Schema.Struct({ pid: Schema.Int, boot: Schema.Finite })
const Interruption = Schema.Struct({
  at: Schema.Finite,
  cause: Schema.String,
  reportedAt: Schema.optional(Schema.Finite),
  resumedAt: Schema.optional(Schema.Finite),
  dismissedAt: Schema.optional(Schema.Finite),
})
const Waiting = Schema.Struct({
  kind: Schema.Literals(["permission", "question"]),
  requestID: Schema.String,
  since: Schema.Finite,
  expiresAt: Schema.optional(Schema.Finite),
  notedAt: Schema.optional(Schema.Finite),
  summary: Schema.optional(Schema.String),
})
const Stop = Schema.Struct({ by: Schema.Literals(["user", "agent", "system"]), at: Schema.Finite })
const Reports = Schema.Struct({ at: Schema.Array(Schema.Finite), wakes: Schema.Finite })
const REPORTS_KEPT = 12
const Workflow = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("run"),
    title: Schema.String,
    revision: Schema.Finite,
    quiet: Schema.optional(Schema.Boolean),
    progress: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    role: Schema.Literal("agent"),
    runID: Schema.String,
    stage: Schema.String,
    phase: Schema.String,
    item: Schema.String,
    key: Schema.String,
    round: Schema.optional(Schema.Finite),
    verifier: Schema.optional(Schema.Boolean),
    final: Schema.optional(Schema.Boolean),
    verified: Schema.optional(Schema.Boolean),
    output: Schema.optional(Schema.Literals(["structured", "text"])),
  }),
])

function decoded<S extends Schema.Decoder<unknown, never>>(schema: S, input: unknown): S["Type"] | undefined {
  if (input === undefined) return undefined
  const result = Schema.decodeUnknownOption(schema)(input)
  return result._tag === "Some" ? result.value : undefined
}

/** An isolation view without its absolute directory, for anyone but the owner or a principal in control (I19). */
export function withoutDirectory<T extends { directory?: string }>({ directory: _, ...rest }: T): Omit<T, "directory"> {
  return rest
}

// The fields added for multi-agent work: each one valid, or undefined so the spread original is not kept.
function extensions(value: Record<string, unknown>): Partial<SubagentRecord> {
  const oneOf = <T extends string>(input: unknown, values: readonly T[]) =>
    values.includes(input as T) ? (input as T) : undefined
  const text = (input: unknown) => (typeof input === "string" ? input : undefined)
  const structured = decoded(Structured, value.structured)
  const interruption = decoded(Interruption, value.interruption)
  const reports = decoded(Reports, value.reports)
  const isolation = decoded(Task.Isolation, value.isolation)
  return {
    conversationID: text(value.conversationID),
    rootSessionID: text(value.rootSessionID),
    requestID: text(value.requestID),
    slotReason: text(value.slotReason),
    effort: oneOf(value.effort, SUBAGENT_EFFORTS),
    modelSource: oneOf(value.modelSource, SUBAGENT_MODEL_SOURCES),
    fork: decoded(Fork, value.fork),
    structured:
      structured && JSON.stringify(structured.schema).length <= STRUCTURED_SCHEMA_MAX
        ? { ...structured, schema: { ...structured.schema } }
        : undefined,
    delegatedScope: decoded(DelegatedScope, value.delegatedScope),
    owner: decoded(Owner, value.owner),
    // A cause a newer version added reads as unknown rather than losing the interruption.
    interruption: interruption
      ? { ...interruption, cause: oneOf(interruption.cause, SUBAGENT_INTERRUPTION_CAUSES) ?? "unknown" }
      : undefined,
    waiting: decoded(Waiting, value.waiting),
    stop: decoded(Stop, value.stop),
    reports: reports ? { at: reports.at.slice(-REPORTS_KEPT), wakes: reports.wakes } : undefined,
    // The absolute directory never stays in the record, which guests can read (I19); the isolation registry holds it.
    isolation: isolation ? withoutDirectory(isolation) : undefined,
    workflow: decoded(Workflow, value.workflow) as SubagentRecord["workflow"],
  }
}

export function read(info: Pick<Session.Info, "metadata">): SubagentRecord | undefined {
  const value = info.metadata?.[METADATA_KEY]
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    typeof value.agent !== "string" ||
    typeof value.parentSessionID !== "string" ||
    typeof value.parentMessageID !== "string" ||
    typeof value.startedAt !== "number" ||
    !Number.isFinite(value.startedAt) ||
    !["queued", "running", "completed", "error", "cancelled"].includes(String(value.status)) ||
    !isRecord(value.model) ||
    typeof value.model.providerID !== "string" ||
    typeof value.model.modelID !== "string"
  )
    return undefined
  const strings = (input: unknown) =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : undefined
  const optionalString = (input: unknown) => (typeof input === "string" ? input : undefined)
  const budget = Schema.decodeUnknownOption(RunBudget.Info)(value.budget)
  const scopes = Schema.decodeUnknownOption(Schema.Array(Task.BudgetScope))(value.budgetScopes)
  return {
    ...value,
    ownedPaths: strings(value.ownedPaths),
    dependsOn: strings(value.dependsOn),
    successCriteria: strings(value.successCriteria),
    batchID: optionalString(value.batchID),
    resultRef: optionalString(value.resultRef),
    resultSummary: optionalString(value.resultSummary),
    reason: optionalString(value.reason),
    error: optionalString(value.error),
    completedAt:
      typeof value.completedAt === "number" && Number.isFinite(value.completedAt) ? value.completedAt : undefined,
    attempt:
      typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt > 0
        ? value.attempt
        : undefined,
    budget: budget._tag === "Some" ? budget.value : undefined,
    budgetScopes: scopes._tag === "Some" ? scopes.value : undefined,
    notification:
      isRecord(value.notification) &&
      typeof value.notification.text === "string" &&
      typeof value.notification.launchID === "string" &&
      ["completed", "error", "cancelled"].includes(String(value.notification.state))
        ? {
            ...value.notification,
            messageID: optionalString(value.notification.messageID),
            claimedAt:
              typeof value.notification.claimedAt === "number" && Number.isFinite(value.notification.claimedAt)
                ? value.notification.claimedAt
                : undefined,
          }
        : undefined,
    mailbox: Array.isArray(value.mailbox)
      ? value.mailbox.filter(
          (item) =>
            isRecord(item) &&
            typeof item.id === "string" &&
            typeof item.sender === "string" &&
            typeof item.text === "string" &&
            ["steer", "queue"].includes(String(item.delivery)) &&
            typeof item.createdAt === "number" &&
            Number.isFinite(item.createdAt),
        )
      : undefined,
    ...extensions(value),
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

/**
 * Runs `effect` holding one permit of `lock`, which it takes uninterruptibly: a fiber interrupted at a yield just as it
 * took the permit would otherwise keep it for good, and every later caller would wait forever. The effect itself stays
 * as interruptible as the caller.
 */
export const locked =
  (lock: Semaphore.Semaphore) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) => lock.withPermits(1)(restore(effect)))

/** Merges a patch into the child's record. setMetadata replaces the whole metadata object, so this reads first. */
export function write(
  sessions: Session.Interface,
  sessionID: SessionID,
  patch: Partial<SubagentRecord>,
  attempt?: number,
) {
  return Effect.gen(function* () {
    const info = yield* sessions.get(sessionID)
    if (attempt !== undefined && read(info)?.attempt !== attempt) return
    yield* sessions.setMetadata({
      sessionID,
      metadata: { ...info.metadata, [METADATA_KEY]: merge(read(info), patch) },
    })
  }).pipe(locked(metadataLock))
}

/** Public metadata replacement cannot forge, remove or race lifecycle-owned subagent fields. */
export function setPublicMetadata(
  sessions: Session.Interface,
  sessionID: SessionID,
  metadata: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    const current = yield* sessions.get(sessionID)
    const next = { ...metadata }
    delete next[METADATA_KEY]
    if (current.metadata && Object.hasOwn(current.metadata, METADATA_KEY))
      next[METADATA_KEY] = current.metadata[METADATA_KEY]
    yield* sessions.setMetadata({ sessionID, metadata: next })
  }).pipe(locked(metadataLock))
}

export function update(
  sessions: Session.Interface,
  sessionID: SessionID,
  patch: Partial<SubagentRecord>,
  attempt?: number,
) {
  return write(sessions, sessionID, patch, attempt).pipe(
    Effect.catchCause((cause) => Effect.logWarning("subagent lifecycle update failed", { sessionID, cause })),
    Effect.withSpan("SubagentLifecycle.update"),
  )
}

/**
 * Reads the child's record and writes the patch `change` returns, under the lock `write` takes, so a check and the
 * write it decides are one step. Returns `change`'s value, or undefined when there is no record.
 */
export function modify<A>(
  sessions: Session.Interface,
  sessionID: SessionID,
  change: (record: SubagentRecord) => { patch?: Partial<SubagentRecord>; value: A },
) {
  return Effect.gen(function* () {
    const info = yield* sessions.get(sessionID)
    const record = read(info)
    if (!record) return undefined
    const { patch, value } = change(record)
    if (patch)
      yield* sessions.setMetadata({ sessionID, metadata: { ...info.metadata, [METADATA_KEY]: merge(record, patch) } })
    return value
  }).pipe(locked(metadataLock))
}

type Notification = NonNullable<SubagentRecord["notification"]>

/** How long a claim stays its claimer's to write its message before recovery may take it over. */
export const CLAIM_GRACE = 60_000

/**
 * Claims a child's undelivered completion note for the parent message `messageID`, for this attempt: sets
 * `notification.messageID` while it is unset, or while it is still `stale` (a claim whose message was never written).
 * `note` is stored when the record has none. Returns whether this call won, so each note is delivered once, also
 * between engines on one vector.db: the check and the claim are one conditional UPDATE.
 */
export function claimNotification(
  sessions: Session.Interface,
  database: Database.Interface,
  childID: SessionID,
  attempt: number | undefined,
  messageID: MessageID,
  options: { stale?: string; note?: Omit<Notification, "messageID" | "claimedAt"> } = {},
) {
  return Effect.gen(function* () {
    const info = yield* sessions.get(childID)
    const record = read(info)
    const stored = record?.notification
    const note = stored ?? options.note
    if (!record || !note || (attempt !== undefined && record.attempt !== attempt)) return false
    if (stored?.messageID !== undefined && stored.messageID !== options.stale) return false
    const claimed = { ...note, messageID, claimedAt: Date.now() }
    const field = (path: string) => sql`json_extract(${SessionTable.metadata}, ${`$.${METADATA_KEY}.${path}`})`
    const value = JSON.stringify(claimed)
    const won = yield* database.db
      .update(SessionTable)
      .set({ metadata: sql`json_set(${SessionTable.metadata}, ${`$.${METADATA_KEY}.notification`}, json(${value}))` })
      .where(
        and(
          eq(SessionTable.id, childID),
          stored?.messageID === undefined
            ? isNull(field("notification.messageID"))
            : eq(field("notification.messageID"), stored.messageID),
          record.attempt === undefined ? isNull(field("attempt")) : eq(field("attempt"), record.attempt),
        ),
      )
      .returning({ id: SessionTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!won) return false
    // Published like every record write, so clients and the event log carry the claim.
    yield* sessions.setMetadata({
      sessionID: childID,
      metadata: { ...info.metadata, [METADATA_KEY]: merge(record, { notification: claimed }) },
    })
    return true
  }).pipe(locked(metadataLock))
}

/** Whether the session still has the message: it was saved and not reverted since. */
export const written = (database: Database.Interface, sessionID: SessionID, messageID: string) =>
  MessageV2.get({ sessionID, messageID: messageID as MessageID }).pipe(
    Effect.provideService(Database.Service, database),
    Effect.option,
    Effect.map((found) => found._tag === "Some"),
  )

/**
 * Undoes the claims `childIDs` hold for the parent message `messageID` when that message was never written (its prompt
 * failed), so the next recovery delivers those notes. Logs its own failures.
 */
export function releaseNotifications(
  sessions: Session.Interface,
  database: Database.Interface,
  parentID: SessionID,
  messageID: MessageID,
  childIDs: readonly SessionID[],
) {
  return Effect.gen(function* () {
    if (childIDs.length === 0 || (yield* written(database, parentID, messageID))) return
    yield* Effect.forEach(childIDs, (childID) =>
      Effect.gen(function* () {
        const info = yield* sessions.get(childID)
        const record = read(info)
        if (!record?.notification || record.notification.messageID !== messageID) return
        const { messageID: _, claimedAt: __, ...unclaimed } = record.notification
        yield* sessions.setMetadata({
          sessionID: childID,
          metadata: { ...info.metadata, [METADATA_KEY]: merge(record, { notification: unclaimed }) },
        })
      }).pipe(locked(metadataLock)),
    )
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("task note claims could not be released", { parentID, cause })),
  )
}

/** Recover undelivered reports only into a human's next prompt, never into a paid retry after a crash. */
export function recover(
  sessions: Session.Interface,
  database: Database.Interface,
  parentID: SessionID,
  messageID: MessageID,
) {
  return Effect.gen(function* () {
    const children = (yield* sessions.children(parentID)).filter((child) => !child.internal)
    return (yield* Effect.forEach(children, (child) =>
      Effect.gen(function* () {
        const record = read(child)
        const note = record?.notification
        if (!note || ownedHere(record)) return []
        // A claim whose message was never written (its engine stopped first) is taken over once its grace has passed.
        const stale = note.messageID
        if (stale && ((note.claimedAt ?? 0) > Date.now() - CLAIM_GRACE || (yield* written(database, parentID, stale))))
          return []
        if (!(yield* written(database, parentID, note.launchID))) {
          yield* write(sessions, child.id, { notification: undefined }, record.attempt)
          return []
        }
        if (!(yield* claimNotification(sessions, database, child.id, record.attempt, messageID, { stale }))) return []
        return [
          {
            type: "text" as const,
            synthetic: true,
            text: note.text,
            metadata: { taskNotification: { taskID: child.id, state: note.state, recovered: true } },
          },
        ]
      }),
    )).flat()
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
export function observe(
  sessions: Session.Interface,
  sessionID: SessionID,
): Effect.Effect<{ usage: SubagentUsage; failure: ReturnType<typeof failure> } | undefined> {
  return Effect.gen(function* () {
    const info = yield* sessions.get(sessionID)
    const messages = yield* sessions.messages({ sessionID })
    const record = read(info)
    const workflow = record?.workflow?.role === "run"
    let toolUses = 0
    let steps = 0
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "tool") toolUses += 1
        if (part.type === "step-finish") steps += 1
      }
    }
    if (record?.workflow?.role === "run") {
      if (record.workflow.progress.runtime !== undefined) {
        const { WorkflowState } = yield* Effect.promise(() => import("@/orchestration/state"))
        const runtime = yield* WorkflowState.decode(record.workflow.progress.runtime)
        const children = Object.values(runtime.sessions)
        steps += Math.max(
          runtime.usage.steps,
          children.reduce((sum, child) => sum + child.steps, 0),
        )
        toolUses += children.reduce((sum, child) => sum + child.toolUses, 0)
      } else {
        // Before the first checkpoint (or an older trusted record), use real children; never invent zero usage.
        const children = (yield* sessions.children(sessionID)).filter((child) => {
          const role = read(child)?.workflow
          return role?.role === "agent" && role.runID === sessionID
        })
        // Real runs checkpoint before every admission. Missing legacy metadata must not make Stop scan an
        // unbounded history; larger runs keep usage unknown until their durable checkpoint can be read.
        if (children.length > WorkflowMarkers.MAX_READY) return undefined
        for (const child of children) {
          const result = yield* observe(sessions, child.id)
          if (!result) return undefined
          steps += result.usage.steps
          toolUses += result.usage.toolUses
        }
      }
    }
    const tokens = {
      input: (info.tokens?.input ?? 0) + (workflow ? (info.subagentTokens?.input ?? 0) : 0),
      output: (info.tokens?.output ?? 0) + (workflow ? (info.subagentTokens?.output ?? 0) : 0),
      reasoning: (info.tokens?.reasoning ?? 0) + (workflow ? (info.subagentTokens?.reasoning ?? 0) : 0),
      cache: {
        read: (info.tokens?.cache.read ?? 0) + (workflow ? (info.subagentTokens?.cache.read ?? 0) : 0),
        write: (info.tokens?.cache.write ?? 0) + (workflow ? (info.subagentTokens?.cache.write ?? 0) : 0),
      },
    }
    const usage: SubagentUsage = {
      tokensOwnOnly: info.tokensOwnOnly === true && (!workflow || info.subagentTokensOwnOnly === true),
      cost: (info.cost ?? 0) + (workflow ? (info.subagentCost ?? 0) : 0),
      tokens,
      total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
      toolUses,
      steps,
      unpricedSteps: (info.unpricedSteps ?? 0) + (workflow ? (info.subagentUnpricedSteps ?? 0) : 0),
      codiumSteps: (info.codiumSteps ?? 0) + (workflow ? (info.subagentCodiumSteps ?? 0) : 0),
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
 * A child's spend scopes as its record keeps them: the delegated ledger in `delegatedScope`, never in `budgetScopes`,
 * whose fixed kinds older versions decode (I29).
 */
export function scopeFields(
  scopes: readonly SpendGuard.ScopeSnapshot[],
): Pick<SubagentRecord, "budgetScopes" | "delegatedScope"> {
  const delegated = scopes.find((scope) => scope.kind === "delegated")
  return {
    budgetScopes: scopes.filter(
      (scope): scope is SpendGuard.ScopeSnapshot & Task.BudgetScope => scope.kind !== "delegated",
    ),
    ...(delegated && {
      delegatedScope: {
        id: delegated.id,
        budget: delegated.budget,
        spentUsd: delegated.spentUsd,
        steps: delegated.steps,
        unpricedSteps: delegated.unpricedSteps,
        codiumSteps: delegated.codiumSteps,
        ...(delegated.stopped && { stopped: delegated.stopped }),
      },
    }),
  }
}

/**
 * Settles a child's run: its final record, its spend scopes, and what it read (for the parent's memory hold).
 * Undefined when the child has moved on to another attempt. Callers hold `controlLock` through `locked`.
 */
export const finish = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  guard: SpendGuard.Interface,
  taskID: SessionID,
  attempt: number,
  input: { status: FinalStatus; error?: string },
) {
  const current = yield* sessions.get(taskID)
  if (read(current)?.attempt !== attempt) return undefined
  const settled = yield* settle(sessions, taskID, input)
  yield* update(sessions, taskID, scopeFields(yield* guard.scopes(taskID)), attempt)
  yield* guard.release(taskID)
  const hold = SessionMemory.taint(
    yield* sessions
      .messages({ sessionID: taskID })
      .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[]))),
  )
  return { settled, hold }
})

/**
 * How a child's run ends, from its last message: a stopped child cancels the job, and a failed one fails it while
 * keeping what it wrote.
 */
export const settleRun = Effect.fnUntraced(function* (result: SessionV1.WithParts) {
  const text = result.parts
    .flatMap((item) => (item.type === "text" && !item.synthetic && !item.ignored && item.text ? [item.text] : []))
    .join("\n\n")
  const failed = result.info.role === "assistant" ? failure(result.info.error) : undefined
  if (!failed) return text
  if (failed.status === "cancelled") return yield* Effect.interrupt
  return yield* new BackgroundJob.RunFailed({ message: failed.error ?? "Task failed", output: text })
})

/**
 * Merges `patch` into the metadata of the parent's task tool part, found by
 * message and call id, and publishes message.part.updated. The processor
 * writes the tool's returned metadata when it settles the call, so a part
 * that is still pending or running is retried briefly instead of patched. A
 * part that does not exist (a caller without a processor) is skipped. A
 * function `patch` is read when the write lands, from the stored metadata, so it
 * carries the latest state. Each write holds partLock, as patchEntry does.
 */
export function patchPart(input: {
  sessions: Session.Interface
  messageID: MessageID
  callID: string
  patch: object | ((stored: Record<string, unknown> | undefined) => object)
}) {
  const attempt = Effect.gen(function* () {
    const part = (yield* MessageV2.parts(input.messageID)).find(
      (item): item is SessionV1.ToolPart => item.type === "tool" && item.callID === input.callID,
    )
    if (!part) return "missing" as const
    if (part.state.status !== "completed" && part.state.status !== "error") return "pending" as const
    const patch = typeof input.patch === "function" ? input.patch(part.state.metadata) : input.patch
    yield* input.sessions.updatePart({
      ...part,
      state: { ...part.state, metadata: merge(part.state.metadata, patch) },
    })
    return "done" as const
  }).pipe(locked(partLock))
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

// A batch entry's status: a record status, or pending before its child exists.
const unsettled = (status: unknown) => status === "pending" || status === "queued" || status === "running"

/** A batch part's status from its entries: running while any runs, then error, then cancelled, else completed. */
export function batchStatus(tasks: readonly { status?: unknown }[]): "running" | "completed" | "error" | "cancelled" {
  if (tasks.some((item) => unsettled(item.status))) return "running"
  if (tasks.some((item) => item.status === "error")) return "error"
  if (tasks.some((item) => item.status === "cancelled")) return "cancelled"
  return "completed"
}

type PartInput = { sessions: Session.Interface; messageID: MessageID; callID: string }

// Rewrites one stored tool part under partLock. `edit` returns the new state, or undefined to leave the part as it is.
function editPart(
  input: PartInput,
  span: string,
  edit: (part: SessionV1.ToolPart) => SessionV1.ToolPart["state"] | undefined,
) {
  return Effect.gen(function* () {
    const part = (yield* MessageV2.parts(input.messageID)).find(
      (item): item is SessionV1.ToolPart => item.type === "tool" && item.callID === input.callID,
    )
    const state = part ? edit(part) : undefined
    if (!part || !state) return false
    yield* input.sessions.updatePart({ ...part, state })
    return true
  }).pipe(
    locked(partLock),
    Effect.catchCause((cause) =>
      Effect.logWarning("subagent tool part edit failed", {
        messageID: input.messageID,
        callID: input.callID,
        cause,
      }).pipe(Effect.as(false)),
    ),
    Effect.withSpan(span),
  )
}

// A batch part's metadata with `patch` merged into the entries `pick` chooses, and its status recomputed. Undefined
// when the metadata is not a batch's, or it picks no entry.
function patchedBatch(
  metadata: Record<string, unknown> | undefined,
  pick: (entry: Record<string, unknown>, position: number) => boolean,
  patch: object,
): Record<string, unknown> | undefined {
  if (!metadata || metadata.taskBatch !== 1 || !Array.isArray(metadata.tasks)) return undefined
  const tasks: unknown[] = metadata.tasks
  let picked = false
  const next = tasks.map((entry, position) => {
    if (!isRecord(entry) || !pick(entry, position)) return entry
    picked = true
    return merge(entry, patch)
  })
  return picked ? { ...metadata, tasks: next, status: batchStatus(next.filter(isRecord)) } : undefined
}

/** Batch metadata with `patch` merged into entry `index` and the status recomputed; undefined when it is not a batch's. */
export function batchEntry(metadata: Record<string, unknown> | undefined, index: number, patch: object) {
  return patchedBatch(metadata, (_, position) => position === index, patch)
}

/**
 * Merges `patch` into entry `index` of a batch task part's `metadata.tasks` and recomputes the batch status. For a part
 * no live call is writing: an orphaned one, or one whose call has returned. A returned batch writes only its own
 * entries, under the same lock, so a sibling still running keeps this change. Returns whether the part changed.
 */
export function patchEntry(input: PartInput & { index: number; patch: object }) {
  return editPart(input, "SubagentLifecycle.patchEntry", (part) => {
    if (part.state.status === "pending") return undefined
    const metadata = batchEntry(part.state.metadata, input.index, input.patch)
    return metadata ? { ...part.state, metadata } : undefined
  })
}

/**
 * Settles the launching task part of a child whose run Vector lost (an update, restart or crash). A part still pending
 * or running becomes an error marked `interrupted`, with its unsettled entries cancelled; a settled part (a background
 * launch) has only this child's entry, or its own status, moved from running to cancelled. Call it only when the
 * part's owner is gone, since it writes over a part that is not settled. Returns whether the part changed.
 */
export function settleOrphanPart(input: PartInput & { index?: number }) {
  return editPart(input, "SubagentLifecycle.settleOrphanPart", (part) => {
    const now = Date.now()
    const cancelled = { status: "cancelled", interrupted: true, completedAt: now }
    const state = part.state
    if (state.status === "pending" || state.status === "running") {
      const metadata = state.status === "running" ? (state.metadata ?? {}) : {}
      return {
        status: "error",
        input: state.input,
        error: INTERRUPTED_ERROR,
        metadata: {
          ...(patchedBatch(metadata, (entry) => unsettled(entry.status), cancelled) ??
            (unsettled(metadata.status) ? merge(metadata, cancelled) : metadata)),
          interrupted: true,
        },
        time: { start: state.status === "running" ? state.time.start : now, end: now },
      }
    }
    const metadata = state.metadata ?? {}
    if (metadata.taskBatch === 1) {
      const next = patchedBatch(
        metadata,
        (entry, position) => position === input.index && unsettled(entry.status),
        cancelled,
      )
      return next ? { ...state, metadata: next } : undefined
    }
    return unsettled(metadata.status) ? { ...state, metadata: merge(metadata, cancelled) } : undefined
  })
}

export * as SubagentLifecycle from "./subagent-lifecycle"
