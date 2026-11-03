import path from "node:path"
import { Context, Effect, Layer, Option, Schema, Scope } from "effect"
import { and, desc, eq, sql } from "drizzle-orm"
import { Task } from "@vectordevai/schema/task"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { PartTable } from "@vectordevai/core/session/sql"
import { BackgroundJob } from "@/background/job"
import { TaskJobs } from "./jobs"
import { TaskPlace } from "./place"
import { TaskIsolation } from "./isolation"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID, MessageID } from "@/session/schema"
import { SessionTaskSize } from "@/session/task-size"
import { SessionMemory } from "@/session/memory"
import type { SubagentRecord } from "@/agent/subagent-kind"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { TaskStructured } from "@/tool/task-structured"
import { TaskMailbox } from "@vectordevai/core/task-mailbox"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ModelV2 } from "@vectordevai/core/model"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { Config } from "@/config/config"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { disposing } from "@/effect/instance-registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { DesktopTasks } from "./desktop"
import { TaskClaims } from "./claims"
import { TaskLimits } from "./limits"
import { TaskNotify } from "./notify"
import { TaskSignals } from "./signals"
import { SessionFork } from "@/session/fork"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { SubagentModel } from "@/agent/subagent-model"

export class Error extends Schema.TaggedErrorClass<Error>()("TaskManager.Error", {
  code: Schema.Literals([
    "not_found",
    "forbidden",
    "invalid",
    "finished",
    "rate_limited",
    "limit",
    "conflict",
    "running",
  ]),
  message: Schema.String,
}) {}

export type ListInput = {
  /** Engine-only workflow directory; native run coordinators only, without ordinary or desktop task rows. */
  workflows?: boolean
  sessionID: SessionID
  descendants?: boolean
  limit?: number
  /** Only work in flight: finished children are walked through but never listed (5.D.1). */
  active?: boolean
  /** A subagent's view of its parent's other children (D.5). */
  siblings?: boolean
}

/** A sibling as another subagent sees it: nothing that would carry the sibling's progress or output (D.5). */
export type Sibling = Pick<Task.Info, "id" | "title" | "agent" | "status" | "ownedPaths">
export type SiblingList = { tasks: Sibling[]; truncated: boolean }

export interface Interface {
  readonly list: {
    (input: ListInput & { siblings: true }): Effect.Effect<SiblingList, Error>
    (input: ListInput): Effect.Effect<Task.ListResult, Error>
  }
  readonly inspect: (input: { sessionID: SessionID; taskID: string }) => Effect.Effect<Task.InspectResult, Error>
  readonly changes: (input: {
    sessionID: SessionID
    taskID: string
    diff?: boolean
    control?: boolean
  }) => Effect.Effect<Task.ChangesResult, Error>
  readonly counts: (input: { sessionID: SessionID; taskID: string }) => Effect.Effect<Task.ChangesResult, Error>
  readonly merge: (input: { sessionID: SessionID } & TaskIsolation.MergeInput) => Effect.Effect<Task.MergeResult, Error>
  readonly discard: (input: {
    sessionID: SessionID
    taskID: string
    by: TaskIsolation.By
    reason?: string
  }) => Effect.Effect<Task.DiscardResult, Error>
  readonly message: (
    input: {
      sessionID: SessionID
      taskID: string
      text: string
      delivery?: "steer" | "queue"
      /** The user wrote it, through the session's page (default "agent"). */
      origin?: "agent" | "user"
    },
    ops: TaskPromptOps,
  ) => Effect.Effect<Task.MessageResult, Error>
  /** A background subagent's note to its parent while it works (D.5). */
  readonly report: (
    input: { sessionID: SessionID; text: string; wake?: boolean },
    ops: TaskPromptOps,
  ) => Effect.Effect<Task.ReportResult, Error>
  readonly stop: (
    input: {
      sessionID: SessionID
      taskIDs?: readonly string[]
      all?: boolean
      reason?: string
      /** Who stopped them, recorded as `stop.by` (default "agent"). */
      origin?: "agent" | "user"
    },
    ops: TaskPromptOps,
  ) => Effect.Effect<Task.StopResult, Error>
  /** Stops the session's main turn and, with `helpers`, every subagent working under it (5.D.1). */
  readonly interrupt: (
    input: { sessionID: SessionID; helpers: boolean; reason?: string },
    ops: TaskPromptOps,
  ) => Effect.Effect<Task.SessionStopResult, Error>
  /** Moves a root session's running foreground subagents, batch entries included, to the background (5.D.2). */
  readonly promote: (input: {
    sessionID: SessionID
    taskIDs?: readonly string[]
  }) => Effect.Effect<Task.PromoteResult, Error>
  /**
   * Continues stopped, failed or interrupted children of a root session in the background, each in a new attempt (D.3).
   * A completed child continues only from the user, with `text`.
   */
  readonly resume: (
    input: {
      sessionID: SessionID
      taskIDs: readonly string[]
      text?: string
      origin: "agent" | "user"
      /** A guest asked: the guest limits and budget apply. */
      guest: boolean
    },
    ops: TaskPromptOps,
  ) => Effect.Effect<Task.ResumeResult, Error>
  readonly wait: (input: {
    sessionID: SessionID
    taskIDs: readonly string[]
    mode?: "any" | "all"
    timeout?: number
  }) => Effect.Effect<Task.WaitResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/TaskManager") {}

const ACTIVE = new Set<string>(["queued", "running", "waiting_on_user"])
const MAX_TASKS = 200
// Sessions the active board walks, finished ones included, before it calls itself truncated.
const MAX_VISITED = 2000
// "Stop including helpers" sweeps the board once, then again while a sweep still found work to stop (a grandchild
// launched mid-sweep), at most this many times in all.
const SWEEPS = 4
const STOP_REASON = "Stopped by the parent session; partial work was retained."
const INTERRUPT_REASON = "Stopped with the main agent; partial work was kept."
const OUTPUT_LIMIT = 4096
// A structured answer as inspect shows it: pretty JSON cut to this many UTF-8 bytes.
const STRUCTURED_LIMIT = 8 * 1024
// The most messages inspect shows for a task, sent to it and reported up together.
const MAX_MESSAGES = 50
const FOREGROUND_REPORT = "Your parent is waiting on you; put this in your final report."
const ENDED_REPORT = "This run has ended; no report was sent."
// The most children one resume call continues.
const MAX_RESUME = 32
// Research agents (Agent.RESEARCH, RESEARCHER and RESEARCH_JUDGE) start from a checked brief, which a resume would skip.
const RESEARCH_AGENTS = new Set(["research", "researcher", "research-judge"])
// A record whose engine is gone, found before TaskRecovery reported it: why it stopped is unknown (D.3).
const abandon = (at: number) => ({
  status: "cancelled" as const,
  completedAt: at,
  reason: "Engine restarted; partial work was retained. Resume explicitly to continue.",
  interruption: { at, cause: "unknown" as const },
})
// How many messages sent to a task have not reached it yet; nothing when none wait.
const inbox = (record: SubagentRecord) => {
  const unread = (record.mailbox ?? []).filter((item) => item.deliveredAt === undefined).length
  return unread > 0 ? { inbox: { unread } } : {}
}
const recentActiveFirst = (left: { status: string; startedAt: number }, right: { status: string; startedAt: number }) =>
  Number(ACTIVE.has(right.status)) - Number(ACTIVE.has(left.status)) || right.startedAt - left.startedAt

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const jobs = TaskJobs.routed(background, sessions)
    const statuses = yield* SessionStatus.Service
    const permissions = yield* Permission.Service
    const questions = yield* Question.Service
    const database = yield* Database.Service
    const guard = yield* SpendGuard.Service
    const desktop = yield* DesktopTasks.Service
    const limits = yield* TaskLimits.Service
    const config = yield* Config.Service
    const guests = yield* FreeModelGuests.Service
    const store = yield* BackgroundJobStore.Service
    const notify = yield* TaskNotify.Service
    const flags = yield* RuntimeFlags.Service
    const signals = yield* TaskSignals.Service
    const forks = yield* SessionFork.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service
    const isolation = yield* TaskIsolation.Service
    const audience = yield* SessionAudience.Service
    const isolated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) => {
          const code =
            cause instanceof TaskIsolation.IsolationError && ["running", "conflict", "forbidden"].includes(cause.code)
              ? (cause.code as "running" | "conflict" | "forbidden")
              : "invalid"
          return new Error({ code, message: cause instanceof globalThis.Error ? cause.message : String(cause) })
        }),
      )
    const bridge = <A>(effect: Effect.Effect<A, DesktopTasks.Error>) =>
      effect.pipe(Effect.mapError((error) => new Error({ code: error.code, message: error.message })))
    const lock = SubagentLifecycle.controlLock
    const get = (id: SessionID) =>
      sessions
        .get(id)
        .pipe(Effect.mapError(() => new Error({ code: "not_found", message: "Task session was not found." })))
    const persist = (sessionID: SessionID, patch: Parameters<typeof SubagentLifecycle.write>[2], attempt?: number) =>
      SubagentLifecycle.write(sessions, sessionID, patch, attempt).pipe(
        Effect.mapError(
          () => new Error({ code: "not_found", message: "Task disappeared before its state could be saved." }),
        ),
      )

    const requireTask = Effect.fn("TaskManager.requireTask")(function* (
      sessionID: SessionID,
      taskID: string,
      peer = false,
    ) {
      const requester = yield* get(sessionID)
      const parsed = Schema.decodeUnknownOption(SessionID)(taskID)
      if (parsed._tag === "None")
        return yield* new Error({ code: "invalid", message: "Task IDs must be valid session identifiers." })
      const task = yield* get(parsed.value)
      if (task.internal || !SubagentLifecycle.read(task))
        return yield* new Error({ code: "not_found", message: "This session is not a visible delegated task." })
      if (peer && requester.parentID && requester.parentID === task.parentID && SubagentLifecycle.read(requester))
        return task
      const seen = new Set<string>([task.id])
      let parentID = task.parentID
      while (parentID && seen.size <= MAX_TASKS) {
        if (parentID === sessionID) return task
        if (seen.has(parentID)) break
        seen.add(parentID)
        parentID = (yield* get(parentID)).parentID
      }
      return yield* new Error({ code: "forbidden", message: "The task does not belong to this session's descendants." })
    })

    // A workflow run whose engine is gone leaves its own running or queued agents behind with it (D.3). Inert until
    // runs exist (WP31).
    const cascade = Effect.fn("TaskManager.cascade")(function* (runID: SessionID, at: number) {
      yield* Effect.forEach(
        yield* sessions.children(runID),
        (agent) =>
          Effect.gen(function* () {
            const record = SubagentLifecycle.read(agent)
            if (record?.workflow?.role !== "agent" || !SubagentLifecycle.open(record)) return
            if ((yield* jobs.get(agent.id)) || (yield* SubagentLifecycle.liveness(store, agent, record)) !== "dead")
              return
            yield* SubagentLifecycle.update(sessions, agent.id, abandon(at), record.attempt)
          }),
        { concurrency: 4, discard: true },
      )
    })

    // Move to background (5.D.2) and resume (D.3) are offered only for a direct child of a root session: a subagent's own
    // children stay in its run, since their reports would start a turn of the subagent after that run ended. Resume is
    // offered for a finished child that started, so the user can continue it.
    const offers = Effect.fn("TaskManager.offers")(function* (
      session: Session.Info,
      record: SubagentRecord,
      job: BackgroundJob.Info | undefined,
      status: Task.Status,
      started: boolean,
    ) {
      if (!flags.backgroundSubagents || SubagentLifecycle.stopping.has(session.id) || !session.parentID) return {}
      if (record.workflow) return {}
      const background = ACTIVE.has(status) && job?.status === "running" && job.metadata?.background !== true
      const resume =
        !ACTIVE.has(status) &&
        job?.status !== "running" &&
        started &&
        !RESEARCH_AGENTS.has(record.agent) &&
        record.interruption?.dismissedAt === undefined
      if (!background && !resume) return {}
      const parent = yield* sessions.get(session.parentID).pipe(Effect.option)
      if (Option.isNone(parent) || parent.value.parentID) return {}
      return background ? { background: true } : { resume: true }
    })

    const observe = Effect.fn("TaskManager.observe")(function* (
      initial: Session.Info,
    ): Effect.fn.Return<Task.Info, Error> {
      const record = SubagentLifecycle.read(initial)!
      const job = yield* jobs.get(initial.id)
      const live = (yield* statuses.get(initial.id)).type !== "idle"
      const abandoned =
        !job &&
        !live &&
        SubagentLifecycle.open(record) &&
        (yield* SubagentLifecycle.liveness(store, initial, record)) === "dead"
      if (abandoned) {
        const at = Date.now()
        yield* SubagentLifecycle.update(sessions, initial.id, abandon(at), record.attempt)
        if (record.workflow?.role === "run") yield* cascade(initial.id, at)
      }
      const session = abandoned ? yield* get(initial.id) : initial
      const current = SubagentLifecycle.read(session)!
      // A request pending here, or one a record says its child waits on in an engine that still runs it (D.4).
      const pending =
        [
          ...(yield* permissions.list().pipe(TaskPlace.atHome(session.id))),
          ...(yield* questions.list().pipe(TaskPlace.atHome(session.id))),
        ].some((item) => item.sessionID === session.id) ||
        (!job && !abandoned && current.waiting !== undefined && SubagentLifecycle.open(current))
      const status: Task.Status =
        abandoned || current.status === "cancelled" || job?.status === "cancelled" || job?.status === "interrupted"
          ? "stopped"
          : current.status === "error" || job?.status === "error"
            ? "failed"
            : current.status === "completed" || job?.status === "completed"
              ? "completed"
              : pending
                ? "waiting_on_user"
                : current.status === "queued"
                  ? "queued"
                  : "running"
      const recent = yield* sessions.messages({ sessionID: session.id, limit: 4 }).pipe(Effect.orDie)
      const tool = recent.flatMap((message) => message.parts).findLast((part) => part.type === "tool")
      const counts = yield* database.db
        .select({
          tools: sql<number>`coalesce(sum(case when json_extract(${PartTable.data}, '$.type') = 'tool' then 1 else 0 end), 0)`,
          steps: sql<number>`coalesce(sum(case when json_extract(${PartTable.data}, '$.type') = 'step-finish' then 1 else 0 end), 0)`,
        })
        .from(PartTable)
        .where(eq(PartTable.session_id, session.id))
        .get()
        .pipe(Effect.orDie)
      const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      const workflow =
        current.workflow?.role === "run"
          ? Option.getOrUndefined(
              Schema.decodeUnknownOption(Task.Workflow)({
                ...current.workflow.progress,
                role: "run",
                runID: session.id,
                title: current.workflow.title,
                stages: Array.isArray(current.workflow.progress.stages)
                  ? current.workflow.progress.stages.map((stage) =>
                      typeof stage === "object" && stage !== null
                        ? { ...stage, phase: "phase" in stage ? (stage.phase ?? "") : "" }
                        : stage,
                    )
                  : undefined,
              }),
            )
          : current.workflow?.role === "agent"
            ? { ...current.workflow }
            : undefined
      const usage =
        current.workflow?.role === "run"
          ? (yield* SubagentLifecycle.observe(sessions, session.id))?.usage
          : {
              cost: session.cost ?? 0,
              tokens,
              total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
              toolUses: Number(counts?.tools ?? 0),
              steps: Number(counts?.steps ?? 0),
              unpricedSteps: session.unpricedSteps,
              codiumSteps: session.codiumSteps,
              tokensOwnOnly: session.tokensOwnOnly === true,
            }
      // Pricing evidence is independent of token provenance. Even when a checkpoint
      // cannot supply step counts, these canonical session counters remain known.
      const codium =
        usage?.codiumSteps ??
        (session.codiumSteps ?? 0) + (current.workflow?.role === "run" ? (session.subagentCodiumSteps ?? 0) : 0)
      const unpriced =
        usage?.unpricedSteps ??
        (session.unpricedSteps ?? 0) + (current.workflow?.role === "run" ? (session.subagentUnpricedSteps ?? 0) : 0)
      // A registry that cannot be read leaves this task's isolation unreported rather than failing every list.
      const privateWork = yield* isolation
        .find(session.id)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("isolated task record unreadable", { taskID: session.id, cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        )
      const owner = yield* RequestOwner.owner
      const completedAt = current.completedAt ?? job?.completed_at
      return {
        id: session.id,
        sessionID: session.id,
        parentSessionID: session.parentID!,
        source: "subagent",
        title: current.title.slice(0, 240),
        agent: current.agent,
        status,
        batchID: current.batchID,
        startedAt: current.startedAt,
        completedAt,
        elapsedMs: Math.max(0, (completedAt ?? Date.now()) - current.startedAt),
        currentStep: pending
          ? "Waiting for your answer or permission"
          : tool?.type === "tool"
            ? tool.state.status === "running"
              ? (tool.state.title ?? tool.tool).slice(0, 240)
              : tool.tool.slice(0, 240)
            : undefined,
        lastTool: tool?.type === "tool" ? tool.tool : undefined,
        usage,
        ...(!usage
          ? { measuredCost: (session.cost ?? 0) + (current.workflow?.role === "run" ? (session.subagentCost ?? 0) : 0) }
          : {}),
        ...(codium > 0 ? { billing: "codium" as const } : {}),
        ...(unpriced > codium ? { costKind: "unknown" as const } : {}),
        ...(workflow
          ? {
              workflow:
                workflow.role === "run"
                  ? {
                      ...workflow,
                      // Editable progress cannot borrow a canonical proof to certify its own number.
                      tokens:
                        usage?.tokensOwnOnly === true && !(codium > 0 && usage.total === 0)
                          ? { used: usage.total, max: workflow.tokens?.max }
                          : undefined,
                    }
                  : workflow,
            }
          : {}),
        ...(current.workflow?.role === "agent" ? { groupID: `workflow:${current.workflow.runID}` } : {}),
        ownedPaths: current.ownedPaths ?? [],
        dependsOn: current.dependsOn ?? [],
        resultAvailable: Boolean(
          current.resultRef ||
            job?.output ||
            recent.some(
              (message) =>
                message.info.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && !part.synthetic && part.text),
            ),
        ),
        resultRef: current.resultRef ?? `session:${session.id}`,
        reason: (current.reason ?? current.error ?? job?.error)?.slice(0, 1000),
        attempt: current.attempt ?? 1,
        budget: current.budget,
        budgetScopes: ACTIVE.has(status)
          ? SubagentLifecycle.scopeFields(yield* guard.scopes(session.id)).budgetScopes
          : current.budgetScopes,
        controls: {
          inspect: true,
          message:
            current.workflow?.role !== "run" &&
            ACTIVE.has(status) &&
            job?.status === "running" &&
            !SubagentLifecycle.stopping.has(session.id),
          stop: ACTIVE.has(status) && !SubagentLifecycle.stopping.has(session.id),
          ...(yield* offers(session, current, job, status, recent.length > 0)),
          ...(privateWork
            ? {
                merge: privateWork.state === "changed",
                discard: ["changed", "diverged"].includes(privateWork.state),
              }
            : {}),
        },
        ...(privateWork ? { isolation: TaskIsolation.info(privateWork, owner) } : {}),
        ...(status === "waiting_on_user" && current.waiting
          ? {
              waiting: SubagentLifecycle.defined({
                kind: current.waiting.kind,
                since: current.waiting.since,
                requestID: current.waiting.requestID,
                expiresAt: current.waiting.expiresAt,
                summary: current.waiting.summary,
              }) as Task.Waiting,
            }
          : {}),
        ...(current.interruption
          ? {
              interrupted: SubagentLifecycle.defined({
                at: current.interruption.at,
                cause: current.interruption.cause,
                reported: current.interruption.reportedAt !== undefined,
                resumedAt: current.interruption.resumedAt,
                dismissedAt: current.interruption.dismissedAt,
              }) as Task.Interrupted,
            }
          : {}),
        ...(current.structured
          ? {
              result: SubagentLifecycle.defined({
                format: "json",
                valid: current.structured.valid,
                attempts: current.structured.attempts,
              }) as Task.Result,
            }
          : {}),
        ...inbox(current),
      }
    })

    // The conversation's subagent limits as `session` sees them (5.B.10): its root's pool, and the request its launches
    // count in. For a root that is the request its prompt loop counts launches in now, so a new request with no
    // launches shows none started, while a message that joined the running request keeps that request's count; a
    // Parallel Workspace or Swarm root shows its conversation's request, which its launches count in (5.B.1).
    const limitsOf = Effect.fn("TaskManager.limits")(function* (session: Session.Info) {
      let root = session
      const seen = new Set<string>([root.id])
      while (root.parentID && !seen.has(root.parentID) && seen.size <= MAX_TASKS) {
        seen.add(root.parentID)
        const parent = yield* sessions.get(root.parentID).pipe(Effect.option)
        if (Option.isNone(parent)) break
        root = parent.value
      }
      const guest = yield* guests.marked(root.id)
      const conversationID = yield* TaskLimits.conversationOf(sessions, root, guest)
      const status = yield* limits.status(
        conversationID,
        SubagentLifecycle.read(session)?.requestID ??
          (yield* TaskLimits.requestFor(limits, sessions, SessionID.make(conversationID))),
        TaskLimits.resolve(yield* config.get(), guest),
      )
      return {
        running: status.running,
        queued: status.queued,
        maxRunning: status.limit,
        launched: status.launched,
        maxPerRequest: status.perRequest,
        ...(status.spend ? { spend: status.spend } : {}),
      } satisfies Task.Limits
    })

    // A subagent's view of its parent's other children (D.5): who they are and what they own, never their progress,
    // reasons or output, so one sibling's tool output never reaches another.
    const siblings = Effect.fn("TaskManager.siblings")(function* (input: ListInput) {
      const session = yield* get(input.sessionID)
      const record = SubagentLifecycle.read(session)
      if (!session.parentID || session.internal || !record)
        return yield* new Error({ code: "forbidden", message: "Only a subagent has siblings to list." })
      if (RESEARCH_AGENTS.has(record.agent))
        return yield* new Error({ code: "forbidden", message: "Research agents cannot list their siblings." })
      const limit = Math.min(MAX_TASKS, Math.max(1, Math.floor(input.limit ?? 100)))
      const others = (yield* sessions.children(session.parentID))
        .filter((item) => item.id !== session.id && !item.internal && SubagentLifecycle.read(item))
        .sort((left, right) => recentActiveFirst(SubagentLifecycle.read(left)!, SubagentLifecycle.read(right)!))
      const tasks = yield* Effect.forEach(others.slice(0, limit), observe, { concurrency: 4 })
      return {
        tasks: tasks.map(
          ({ id, title, agent, status, ownedPaths }): Sibling => ({ id, title, agent, status, ownedPaths }),
        ),
        truncated: others.length > limit,
      }
    })

    const list = Effect.fn("TaskManager.list")(function* (
      input: ListInput,
    ): Effect.fn.Return<Task.ListResult | SiblingList, Error> {
      if (input.siblings) return yield* siblings(input)
      const session = yield* get(input.sessionID)
      const { cut: _, ...result } = yield* collect(input)
      // The board never fails for want of its limits line.
      const counted = yield* limitsOf(session).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("TaskManager.list: reading the subagent limits failed", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      return counted ? { ...result, limits: counted } : result
    })

    const collect = Effect.fn("TaskManager.collect")(function* (input: ListInput) {
      yield* get(input.sessionID)
      const limit = Math.min(MAX_TASKS, Math.max(1, Math.floor(input.limit ?? 100)))
      const queue = [input.sessionID]
      const seen = new Set<string>(queue)
      const found: Session.Info[] = []
      // The active board lists only open records (abandoned ones too, so observe settles them), yet walks under every
      // child, finished or not, until its own budget of sessions runs out: finished children never crowd it out.
      while (queue.length && (input.active ? seen.size <= MAX_VISITED : found.length <= MAX_TASKS)) {
        const children = (yield* sessions.children(queue.shift()!))
          .filter(
            (item) =>
              !item.internal &&
              SubagentLifecycle.read(item) &&
              (!input.workflows || SubagentLifecycle.read(item)?.workflow?.role === "run"),
          )
          .sort((left, right) => recentActiveFirst(SubagentLifecycle.read(left)!, SubagentLifecycle.read(right)!))
        for (const child of children) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          if (!input.active || SubagentLifecycle.open(SubagentLifecycle.read(child))) found.push(child)
          if (input.descendants && SubagentLifecycle.read(child)?.workflow?.role !== "run") queue.push(child.id)
        }
        if (!input.descendants) break
      }
      const native = yield* Effect.forEach(
        found
          .sort((left, right) => recentActiveFirst(SubagentLifecycle.read(left)!, SubagentLifecycle.read(right)!))
          .slice(0, limit),
        observe,
        { concurrency: 4 },
      )
      const external = input.workflows ? { tasks: [], truncated: false } : yield* bridge(desktop.list(input))
      // A desktop workspace can expose the same native child session; retain its
      // richer source identity and controls, counting cumulative usage only once.
      const mirrored = new Set(external.tasks.flatMap((task) => (task.sessionID ? [task.sessionID] : [])))
      const rows = input.active ? external.tasks.filter((task) => ACTIVE.has(task.status)) : external.tasks
      const tasks = [
        ...native.filter((task) => !mirrored.has(task.id) && (!input.active || ACTIVE.has(task.status))),
        ...rows.map((task) => {
          const session = native.find((entry) => entry.id === task.sessionID)
          return session ? { ...task, usage: session.usage, budgetScopes: session.budgetScopes } : task
        }),
      ].sort(recentActiveFirst)
      // What the board leaves out: native rows (a walk cut short, or past the limit), or desktop rows. A desktop listing
      // cut short matters to the active board only while it returned live rows.
      const omitted = tasks.slice(limit)
      const cut = {
        native: found.length > limit || queue.length > 0 || omitted.some((task) => !DesktopTasks.owns(task.id)),
        desktop:
          (external.truncated && (!input.active || rows.length > 0)) ||
          omitted.some((task) => DesktopTasks.owns(task.id)),
      }
      return { tasks: tasks.slice(0, limit), truncated: cut.native || cut.desktop, cut }
    })

    // A task with no isolation record has nothing to review, merge or discard, and the registry path stays private.
    const requireIsolated = Effect.fn("TaskManager.requireIsolated")(function* (taskID: SessionID) {
      const record = yield* isolated(isolation.find(taskID))
      if (!record) return yield* new Error({ code: "not_found", message: "This task has no isolated changes." })
      return record
    })

    const counts: Interface["counts"] = Effect.fn("TaskManager.counts")(function* (input) {
      const session = yield* requireTask(input.sessionID, input.taskID)
      const record = yield* requireIsolated(session.id)
      const count = (value: number) => (Number.isFinite(value) && value >= 0 ? value : 0)
      const display = TaskIsolation.info(record)
      const state =
        display.state === "discarding"
          ? "settling"
          : [
                "preparing",
                "active",
                "settling",
                "unchanged",
                "changed",
                "merged",
                "discarded",
                "diverged",
                "failed",
              ].includes(display.state)
            ? display.state
            : "failed"
      const status =
        state === "preparing"
          ? "queued"
          : ["active", "settling"].includes(state)
            ? "running"
            : state === "failed" || state === "diverged"
              ? "failed"
              : "completed"
      return {
        task: {
          id: session.id,
          sessionID: session.id,
          parentSessionID: session.parentID!,
          source: "subagent",
          title: "Isolated task",
          status,
          startedAt: 0,
          elapsedMs: 0,
          ownedPaths: [],
          dependsOn: [],
          resultAvailable: false,
          attempt: 0,
          controls: { inspect: false, message: false, stop: false },
          isolation: {
            mode: record.mode,
            state,
            files: count(display.files ?? 0),
            additions: count(display.additions ?? 0),
            deletions: count(display.deletions ?? 0),
          },
        },
        files: [],
        truncated: false,
        mergeable: "unknown",
      }
    })

    const changes: Interface["changes"] = Effect.fn("TaskManager.changes")(function* (input) {
      const session = yield* requireTask(input.sessionID, input.taskID)
      yield* requireIsolated(session.id)
      const result = yield* isolated(
        isolation.changes({ taskID: session.id, diff: input.diff, control: input.control }),
      )
      return {
        task: yield* observe(session),
        files: result.files,
        ...(result.patch !== undefined ? { patch: result.patch } : {}),
        truncated: result.truncated,
        mergeable: result.mergeable,
      }
    })
    const merge: Interface["merge"] = Effect.fn("TaskManager.merge")(function* (input) {
      const session = yield* requireTask(input.sessionID, input.taskID)
      if (input.by.kind === "agent" && (session.parentID !== input.sessionID || input.by.sessionID !== input.sessionID))
        return yield* new Error({ code: "forbidden", message: "An agent may merge only its direct children." })
      if (input.by.kind === "owner" && !(yield* RequestOwner.owner))
        return yield* new Error({ code: "forbidden", message: "Only the authenticated owner may merge this task." })
      yield* requireIsolated(session.id)
      const result = yield* isolated(isolation.merge(input))
      return {
        task: yield* observe(session),
        merged: result.merged,
        remaining: result.remaining,
        conflicts: result.conflicts,
        ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
      }
    })
    const discard: Interface["discard"] = Effect.fn("TaskManager.discard")(function* (input) {
      const session = yield* requireTask(input.sessionID, input.taskID)
      if (input.by.kind === "agent" && (session.parentID !== input.sessionID || input.by.sessionID !== input.sessionID))
        return yield* new Error({ code: "forbidden", message: "An agent may discard only its direct children." })
      if (input.by.kind === "owner" && !(yield* RequestOwner.owner))
        return yield* new Error({ code: "forbidden", message: "Only the authenticated owner may discard this task." })
      yield* requireIsolated(session.id)
      const result = yield* isolated(isolation.discard(input))
      return { task: yield* observe(session), ...(result.saved ? { saved: result.saved } : {}) }
    })

    const inspect: Interface["inspect"] = Effect.fn("TaskManager.inspect")(function* (input) {
      if (DesktopTasks.owns(input.taskID)) return yield* bridge(desktop.inspect(input))
      const session = yield* requireTask(input.sessionID, input.taskID)
      const task = yield* observe(session)
      const messages = yield* sessions.messages({ sessionID: session.id, limit: 8 }).pipe(Effect.orDie)
      const parts = messages.flatMap((message) => message.parts)
      const steps = parts
        .flatMap((part) =>
          part.type === "tool"
            ? [
                {
                  tool: part.tool,
                  status: part.state.status,
                  text: (part.state.status === "running" || part.state.status === "completed"
                    ? (part.state.title ?? part.tool)
                    : part.tool
                  ).slice(0, 240),
                },
              ]
            : [],
        )
        .slice(-8)
      const text = messages
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
        .join("\n\n")
      const mail = yield* exchanged(session)
      // A structured child's last answer, as text a client shows and never renders (5.E.2).
      const record = SubagentLifecycle.read(session)
      const report =
        record?.workflow?.role === "run" && typeof record.workflow.progress.report === "string"
          ? record.workflow.progress.report
          : text
      const answer = record?.structured ? TaskStructured.latest(messages) : undefined
      const pretty = answer === undefined ? undefined : JSON.stringify(JSON.parse(answer), null, 2)
      const cut =
        pretty !== undefined && Buffer.byteLength(pretty, "utf8") > STRUCTURED_LIMIT
          ? Buffer.from(pretty, "utf8")
              .subarray(0, STRUCTURED_LIMIT)
              .toString("utf8")
              .replace(/\uFFFD$/, "")
          : undefined
      return {
        task,
        steps,
        output: record?.workflow?.role === "run" ? report.slice(0, OUTPUT_LIMIT) : report.slice(-OUTPUT_LIMIT),
        truncated:
          messages.length >= 8 ||
          report.length > OUTPUT_LIMIT ||
          parts.filter((part) => part.type === "tool").length > 8,
        ...(mail.length > 0 ? { messages: mail } : {}),
        ...(pretty !== undefined
          ? {
              structured: {
                json: cut ?? pretty,
                valid: record?.structured?.valid === true,
                truncated: cut !== undefined,
              },
            }
          : {}),
      }
    })

    // What a task exchanged with the agents above it (D.5): the messages sent to it, from its mailbox, and the notes it
    // reported up, as its parent received them. The latest MAX_MESSAGES, oldest first.
    const exchanged = Effect.fn("TaskManager.exchanged")(function* (session: Session.Info) {
      const mailbox = SubagentLifecycle.read(session)?.mailbox ?? []
      // A message from an ancestor came down the task's own line, and any other sender is a sibling. The line above the
      // parent is walked only when some sender is neither the parent nor the user.
      const walk = mailbox.some((item) => item.from !== "user" && item.sender !== session.parentID)
      const ancestors = new Set<string>()
      let next = session.parentID
      while (next && !ancestors.has(next) && ancestors.size <= MAX_TASKS) {
        ancestors.add(next)
        if (!walk) break
        next = Option.getOrUndefined(Option.map(yield* sessions.get(next).pipe(Effect.option), (item) => item.parentID))
      }
      const sent = mailbox.map(
        (item): Task.Message => ({
          id: item.id,
          direction: "to_task",
          sender: item.from === "user" ? "user" : ancestors.has(item.sender) ? "parent" : "peer",
          text: item.text,
          createdAt: item.createdAt,
          ...(item.deliveredAt === undefined ? {} : { deliveredAt: item.deliveredAt }),
        }),
      )
      const rows = session.parentID
        ? yield* database.db
            .select({ id: PartTable.id, created: PartTable.time_created, data: PartTable.data })
            .from(PartTable)
            .where(
              and(
                eq(PartTable.session_id, session.parentID),
                sql`json_extract(${PartTable.data}, '$.metadata.taskMessage.taskID') = ${session.id}`,
              ),
            )
            .orderBy(desc(PartTable.id))
            .limit(MAX_MESSAGES)
            .all()
            .pipe(Effect.orDie)
        : []
      const reported = rows.flatMap((row): Task.Message[] => {
        const text =
          "text" in row.data && typeof row.data.text === "string" ? TaskMailbox.opened(row.data.text) : undefined
        return text === undefined
          ? []
          : [
              {
                id: row.id,
                direction: "to_parent",
                sender: "task",
                text,
                createdAt: row.created,
                deliveredAt: row.created,
              },
            ]
      })
      return [...sent, ...reported].sort((left, right) => left.createdAt - right.createdAt).slice(-MAX_MESSAGES)
    })

    // The model, variant and request shape a prompt into a child keeps: a fork's from its first own message (5.E.3),
    // which also keeps its prefix held while it answers; any other child's from its record.
    const shape = Effect.fnUntraced(function* (record: SubagentRecord, child?: SessionID) {
      const fields: SessionFork.UserFields = record.fork
        ? yield* forks.userFields(record)
        : {
            model: {
              providerID: ProviderV2.ID.make(record.model.providerID),
              modelID: ModelV2.ID.make(record.model.modelID),
            },
            ...(record.model.variant ? { variant: record.model.variant } : {}),
          }
      if (record.fork && child) yield* forks.hold(MessageID.make(record.fork.point), child)
      const model = { providerID: fields.model.providerID, modelID: fields.model.modelID }
      const extra = {
        ...(fields.system !== undefined ? { system: fields.system } : {}),
        ...(fields.tools ? { tools: fields.tools } : {}),
        ...(fields.executionMode ? { executionMode: fields.executionMode } : {}),
      }
      return {
        request: { model, variant: fields.variant, ...extra },
        settle: { model, ...(fields.variant ? { variant: fields.variant } : {}), ...extra },
      }
    })

    const message: Interface["message"] = Effect.fn("TaskManager.message")(function* (input, ops) {
      const text = input.text.trim()
      const invalid = TaskMailbox.bodyError(text)
      if (invalid) return yield* new Error({ code: "invalid", message: invalid })
      if (DesktopTasks.owns(input.taskID)) return yield* bridge(desktop.message({ ...input, text }))
      // What the sending agent took in travels with its message (D.6); the user's own words carry nothing.
      const carried =
        input.origin === "user"
          ? {}
          : SessionMemory.carried(
              SessionMemory.taint(
                yield* sessions
                  .messages({ sessionID: input.sessionID })
                  .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[]))),
              ),
            )
      return yield* SubagentLifecycle.locked(lock)(
        Effect.gen(function* () {
          const session = yield* requireTask(input.sessionID, input.taskID, true)
          if (SubagentLifecycle.stopping.has(session.id))
            return yield* new Error({ code: "finished", message: "This task is stopping; no message was sent." })
          const requester = yield* get(input.sessionID)
          const relation = requester.parentID && requester.parentID === session.parentID ? "peer" : "parent"
          const record = SubagentLifecycle.read(session)!
          if (record.workflow?.role === "run")
            return yield* new Error({
              code: "invalid",
              message:
                "Workflow runs do not take messages. Stop the run, then resume it through workflow with an edited spec.",
            })
          if ((yield* jobs.get(session.id))?.status !== "running")
            return yield* new Error({
              code: "finished",
              message:
                "The task has finished; no message was sent and no new run was started. To continue it, call task with its task_id.",
            })
          const now = Date.now()
          // A steered child keeps answering in the format it was asked for, so a structured one keeps StructuredOutput.
          const last = (yield* sessions
            .messages({ sessionID: session.id })
            .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))).findLast(
            (item) => item.info.role === "user" && item.info.format !== undefined,
          )?.info
          const asked = last?.role === "user" ? last.format : undefined
          const kept =
            record.structured && !record.fork && asked?.type !== "json_schema"
              ? TaskStructured.format(record.structured.schema)
              : asked
          const mailbox = record.mailbox ?? []
          const limited = TaskMailbox.admissionError({
            text,
            sentAt: mailbox.filter((item) => item.sender === input.sessionID).map((item) => item.createdAt),
            pending: mailbox.filter((item) => !item.deliveredAt).length,
            now,
          })
          if (limited) return yield* new Error({ code: "rate_limited", message: limited })
          const entry = {
            id: MessageID.ascending(),
            sender: input.sessionID,
            text,
            delivery: input.delivery ?? ("steer" as const),
            createdAt: now,
            ...(input.origin === "user" ? { from: "user" as const } : {}),
          }
          yield* persist(
            session.id,
            { mailbox: [...mailbox.filter((item) => !item.deliveredAt || item.createdAt > now - 60_000), entry] },
            record.attempt,
          )
          const delivery = Effect.gen(function* () {
            const current = yield* get(session.id)
            const value = SubagentLifecycle.read(current)!
            if (value.attempt !== record.attempt) return ""
            yield* persist(
              session.id,
              {
                mailbox: (value.mailbox ?? []).map((item) =>
                  item.id === entry.id ? { ...item, deliveredAt: Date.now() } : item,
                ),
                ...(value.slotReason === TaskLimits.SLOT_REASON
                  ? { status: "running" as const, slotReason: undefined }
                  : {}),
              },
              record.attempt,
            )
            // A fork keeps the request shape of its first own message (5.E.3), and its prefix while it runs.
            const shaped = yield* shape(value, session.id)
            const result = yield* ops.prompt({
              sessionID: session.id,
              messageID: entry.id,
              agent: record.agent,
              ...shaped.request,
              ...(kept ? { format: kept } : {}),
              parts: [
                {
                  type: "text",
                  synthetic: true,
                  text: TaskMailbox.envelope(text, { sender: input.sessionID, recipient: session.id, relation }),
                  ...(Object.keys(carried).length > 0 ? { metadata: carried } : {}),
                },
                // A fork answers in a ```json block, so every prompt into it repeats the schema (5.E.2).
                ...(value.fork && value.structured
                  ? [{ type: "text" as const, synthetic: true, text: SessionFork.answerIn(value.structured.schema) }]
                  : []),
              ],
            })
            // A structured child's answer to the message is checked like its first one (5.E.2).
            if (value.structured)
              return (yield* TaskStructured.settle({
                sessions,
                ops,
                sessionID: session.id,
                ...shaped.settle,
                agent: record.agent,
                schema: value.structured.schema,
                mode: value.fork ? "text" : "tool",
                ...(kept ? { format: kept } : {}),
                since: entry.id,
                result,
                attempt: record.attempt,
              })).json
            const failed = result.info.role === "assistant" ? SubagentLifecycle.failure(result.info.error) : undefined
            const output = result.parts
              .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
              .join("\n\n")
            if (failed?.status === "cancelled") return yield* Effect.interrupt
            if (failed) return yield* new BackgroundJob.RunFailed({ message: failed.error ?? "Task failed", output })
            return output
          }).pipe(Effect.onInterrupt(() => ops.cancel(session.id)))
          // A run that starts after the child's own ended takes a subagent slot again, waiting for one when every slot
          // is taken; one joining a running run shares its slot (5.B.3).
          const conversationID = record.conversationID
          const run = conversationID
            ? limits.run(
                {
                  conversationID,
                  childID: session.id,
                  origin:
                    record.workflow?.role === "agent"
                      ? "workflow"
                      : record.rootSessionID && session.parentID !== record.rootSessionID
                        ? "nested"
                        : "root",
                  waiting: persist(
                    session.id,
                    { status: "queued", slotReason: TaskLimits.SLOT_REASON },
                    record.attempt,
                  ).pipe(Effect.ignore),
                },
                delivery,
              )
            : delivery
          const accepted = yield* jobs.extend({
            id: session.id,
            concurrent:
              entry.delivery === "steer" &&
              record.status !== "queued" &&
              (yield* statuses.get(session.id)).type !== "idle",
            run,
          })
          if (!accepted) {
            yield* persist(session.id, { mailbox }, record.attempt)
            return yield* new Error({
              code: "finished",
              message: "The task finished during admission; no message was sent.",
            })
          }
          return { taskID: session.id, messageID: entry.id, delivery: entry.delivery, accepted: true as const }
        }),
      )
    })

    // A background subagent's note up (D.5): framed as data from the child, carrying what the child took in (D.6), and
    // starting its parent's turn only when it asks to and has not already this attempt.
    const report: Interface["report"] = Effect.fn("TaskManager.report")(function* (input, ops) {
      const text = input.text.trim()
      const invalid = TaskMailbox.bodyError(text)
      if (invalid) return yield* new Error({ code: "invalid", message: invalid })
      const session = yield* get(input.sessionID)
      const record = SubagentLifecycle.read(session)
      const parentID = session.parentID
      if (!parentID || session.internal || !record)
        return yield* new Error({ code: "forbidden", message: "Only a subagent reports to a parent; you have none." })
      if (RESEARCH_AGENTS.has(record.agent))
        return yield* new Error({ code: "forbidden", message: "Research agents report only in their final report." })
      if (record.background !== true) return yield* new Error({ code: "invalid", message: FOREGROUND_REPORT })
      const at = Date.now()
      const admitted = yield* SubagentLifecycle.modify<
        { woke: boolean } | { code: "finished" | "rate_limited"; refused: string }
      >(sessions, session.id, (current) => {
        if (current.attempt !== record.attempt) return { value: { code: "finished", refused: ENDED_REPORT } }
        const sent = current.reports?.at ?? []
        const refused = TaskMailbox.admissionError({ text, sentAt: sent, pending: 0, now: at })
        if (refused) return { value: { code: "rate_limited", refused } }
        const wakes = current.reports?.wakes ?? 0
        const woke = input.wake === true && wakes < TaskMailbox.REPORT_WAKES_PER_ATTEMPT
        return {
          patch: { reports: { at: [...sent, at].slice(-TaskMailbox.MAX_PER_MINUTE), wakes: wakes + (woke ? 1 : 0) } },
          value: { woke },
        }
      }).pipe(Effect.mapError(() => new Error({ code: "not_found", message: "Task session was not found." })))
      if (!admitted) return yield* new Error({ code: "finished", message: ENDED_REPORT })
      if ("refused" in admitted) return yield* new Error({ code: admitted.code, message: admitted.refused })
      const hold = SessionMemory.taint(
        yield* sessions
          .messages({ sessionID: session.id })
          .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[]))),
      )
      const parent = yield* get(parentID)
      yield* notify.enqueue({
        parentID,
        note: {
          kind: "message",
          taskID: session.id,
          launchID: MessageID.make(record.parentMessageID),
          attempt: record.attempt,
          state: "reported",
          text: TaskMailbox.envelope(text, { sender: session.id, recipient: parentID, relation: "child" }),
          wake: admitted.woke,
          ...(hold ? { hold } : {}),
        },
        ops,
        agent: parent.agent ?? "build",
      })
      return { taskID: session.id, parentSessionID: parentID, woke: admitted.woke, at }
    })

    // `capped`: the IDs were chosen by a caller, not collected from the board.
    const select = Effect.fn("TaskManager.select")(function* (
      sessionID: SessionID,
      ids: readonly string[],
      capped = true,
    ) {
      if (ids.length === 0 || (capped && ids.length > MAX_TASKS))
        return yield* new Error({ code: "invalid", message: "Choose 1–200 task IDs." })
      return yield* Effect.forEach([...new Set(ids)], (id) =>
        DesktopTasks.owns(id)
          ? bridge(desktop.get({ sessionID, taskID: id }))
          : requireTask(sessionID, id).pipe(Effect.flatMap(observe)),
      )
    })

    // A row "Stop including helpers" reaches: a native subagent, never a desktop workspace or swarm (5.D.1).
    const helper = (task: Task.Info) => task.source === "subagent" && !DesktopTasks.owns(task.id)

    // This instance's running task jobs below the session that `tasks` does not list. A board walk cut short by a long
    // history still reaches every live helper this way, since the running limits bound the registry.
    const unlisted = Effect.fn("TaskManager.unlisted")(function* (sessionID: SessionID, tasks: readonly Task.Info[]) {
      const known = new Set(tasks.map((task) => task.id))
      const found = yield* Effect.forEach(
        (yield* jobs.list()).filter((job) => job.type === "task" && job.status === "running" && !known.has(job.id)),
        (job) => requireTask(sessionID, job.id).pipe(Effect.flatMap(observe), Effect.option),
        { concurrency: 4 },
      )
      return found.flatMap((task) => (Option.isSome(task) && ACTIVE.has(task.value.status) ? [task.value] : []))
    })

    // Stops the selected tasks of the active board with their descendants and dependents, keeping partial work. With
    // `helpers`, only native subagents are selectable and reached. Returns the stopped tasks and the board it read.
    const halt = Effect.fn("TaskManager.halt")(function* (
      input: {
        sessionID: SessionID
        taskIDs?: readonly string[]
        all?: boolean
        reason?: string
        origin: "agent" | "user"
        helpers?: boolean
      },
      ops: TaskPromptOps,
    ) {
      const reason = input.reason?.trim() || (input.helpers ? INTERRUPT_REASON : STOP_REASON)
      const directory = yield* InstanceState.directory
      const claimed = new Set<SessionID>()
      return yield* Effect.gen(function* () {
        const prepared = yield* SubagentLifecycle.locked(lock)(
          Effect.gen(function* () {
            const board = yield* collect({
              sessionID: input.sessionID,
              descendants: true,
              active: true,
              limit: MAX_TASKS,
            })
            // Chosen IDs stop together or not at all, and so does everything while desktop rows are missing (helpers
            // never include them). A long history never blocks stopping everything: the live native helpers the board
            // left out are added from the job registry.
            if (board.truncated && (!input.all || (board.cut.desktop && !input.helpers)))
              return yield* new Error({
                code: "invalid",
                message: "Too many descendants to stop atomically; select a narrower parent session.",
              })
            const listed = board.cut.native
              ? [...board.tasks, ...(yield* unlisted(input.sessionID, board.tasks))]
              : board.tasks
            const reachable = new Map((input.helpers ? listed.filter(helper) : listed).map((task) => [task.id, task]))
            const selected = input.all ? [...reachable.keys()] : (input.taskIDs ?? [])
            if (input.all && selected.length === 0) return { native: [], remote: [], board: listed }
            // Only the caller's selection is capped at 200. Its verified descendant closure can be larger.
            const chosen = yield* select(input.sessionID, selected, !input.all)
            chosen.forEach((task) => reachable.set(task.id, task))
            const ids = new Set(selected)
            const discovered = new Set<string>()
            const expanded = new Set<string>()
            const visited = new Set(reachable.keys())
            let changed = true
            while (changed) {
              changed = false
              reachable.forEach((task) => {
                if (ids.has(task.id) || (!ids.has(task.parentSessionID) && !task.dependsOn.some((id) => ids.has(id))))
                  return
                ids.add(task.id)
                changed = true
              })
              for (const id of ids) {
                if (discovered.has(id) || DesktopTasks.owns(id)) continue
                discovered.add(id)
                const task = reachable.get(id)!
                if (expanded.has(id) || (task.workflow?.role === "agent" && expanded.has(task.parentSessionID)))
                  continue
                const session = yield* requireTask(input.sessionID, id)
                const record = SubagentLifecycle.read(session)!
                // An agent's siblings may depend on it. Read its actual parent, never a marker naming another run.
                const run =
                  record.workflow?.role === "run"
                    ? session
                    : record.workflow?.role === "agent" && session.parentID
                      ? yield* get(session.parentID)
                      : undefined
                if (!run || expanded.has(run.id) || SubagentLifecycle.read(run)?.workflow?.role !== "run") continue
                expanded.add(run.id)
                const queue = [run.id]
                const walked = new Set<string>(queue)
                // The public board intentionally hides run agents. Rebuild their trusted parent graph here, before
                // claiming or stopping anything, so missing runner fibers cannot leave durable children running.
                // Only open descendants count toward the cap: a large run's finished agents never block its Stop. Past
                // the cap the run coordinator is still stopped, and its interruption cancels its running nodes, whose
                // task calls cancel their own children.
                let capped = false
                while (queue.length && !capped) {
                  for (const child of yield* sessions.children(queue.shift()!)) {
                    const record = SubagentLifecycle.read(child)
                    if (child.internal || !record || walked.has(child.id)) continue
                    walked.add(child.id)
                    queue.push(child.id)
                    if (reachable.has(child.id) || !SubagentLifecycle.open(record)) continue
                    if (!visited.has(child.id) && visited.size >= MAX_VISITED) {
                      capped = true
                      break
                    }
                    visited.add(child.id)
                    reachable.set(child.id, yield* observe(child))
                    changed = true
                  }
                }
                if (capped)
                  yield* Effect.logWarning(
                    "workflow stop reached its open-descendant cap; the rest stop through the run's cancellation",
                    { runID: run.id, open: visited.size },
                  )
              }
            }
            const tasks = yield* select(input.sessionID, [...ids], false)
            const native = yield* Effect.forEach(
              tasks.filter((task) => !DesktopTasks.owns(task.id)),
              (task) =>
                Effect.gen(function* () {
                  if (!ACTIVE.has(task.status) || !task.controls.stop) return { task }
                  const session = yield* requireTask(input.sessionID, task.id)
                  if (SubagentLifecycle.stopping.has(session.id)) return { task }
                  const attempt = SubagentLifecycle.read(session)?.attempt
                  SubagentLifecycle.stopping.add(session.id)
                  claimed.add(session.id)
                  yield* SubagentLifecycle.update(sessions, session.id, { reason }, attempt)
                  return { task, session, attempt }
                }),
              { concurrency: 4 },
            )
            return { native, remote: tasks.filter((task) => DesktopTasks.owns(task.id)), board: listed }
          }),
        )
        const native = yield* Effect.forEach(
          prepared.native,
          (entry) =>
            Effect.gen(function* () {
              if (!("session" in entry) || !entry.session) return entry.task
              const session = entry.session
              const stopped = yield* jobs.cancel(session.id)
              yield* ops.cancel(session.id)
              return yield* SubagentLifecycle.locked(lock)(
                Effect.gen(function* () {
                  SubagentLifecycle.stopping.delete(session.id)
                  claimed.delete(session.id)
                  const current = yield* get(session.id)
                  const record = SubagentLifecycle.read(current)
                  // While Vector goes away, TaskRecovery owns the record (D.3).
                  if (!record || record.attempt !== entry.attempt || disposing(directory))
                    return yield* observe(current)
                  // A job that ended on its own before the stop reached it was not stopped. The cancel does not wait for
                  // its completion (an isolated child's save may still be running Git); whoever waits on the job, its
                  // watcher or the foreground call, settles and reports its real outcome once that is done.
                  if (stopped?.status === "completed" || stopped?.status === "error") return yield* observe(current)
                  const status = SubagentLifecycle.open(record)
                    ? (yield* SubagentLifecycle.settle(sessions, session.id, { status: "cancelled" })).status
                    : record.status
                  yield* persist(
                    session.id,
                    {
                      ...SubagentLifecycle.scopeFields(yield* guard.scopes(session.id)),
                      // Who stopped it, which decides whether resuming it waits for the user (D.3). A child that
                      // finished before the stop reached it was not stopped.
                      ...(status === "cancelled" ? { stop: { by: input.origin, at: Date.now() } } : {}),
                    },
                    entry.attempt,
                  )
                  yield* guard.release(session.id)
                  return yield* get(session.id).pipe(Effect.flatMap(observe))
                }),
              )
            }),
          { concurrency: 4 },
        )
        // A disconnected desktop must not hold the native launch/settlement lock.
        // Stopping a swarm coordinator already cancels its workers and dependencies.
        const roots = new Set(
          prepared.remote
            .filter(
              (task) =>
                task.groupID && task.id === `swarm:${task.groupID}` && ACTIVE.has(task.status) && task.controls.stop,
            )
            .map((task) => task.groupID),
        )
        const controls = prepared.remote.filter(
          (task) =>
            ACTIVE.has(task.status) &&
            task.controls.stop &&
            (!task.groupID || !roots.has(task.groupID) || task.id === `swarm:${task.groupID}`),
        )
        yield* Effect.forEach(
          controls,
          (task) => bridge(desktop.stop({ sessionID: input.sessionID, taskID: task.id, reason: input.reason })),
          { concurrency: 4 },
        )
        const remote = yield* Effect.forEach(prepared.remote, (task) =>
          bridge(desktop.get({ sessionID: input.sessionID, taskID: task.id })),
        )
        return { tasks: [...native, ...remote], board: prepared.board }
      }).pipe(Effect.ensuring(Effect.sync(() => claimed.forEach((id) => SubagentLifecycle.stopping.delete(id)))))
    })

    const stop: Interface["stop"] = Effect.fn("TaskManager.stop")(function* (input, ops) {
      if (input.all && input.taskIDs?.length)
        return yield* new Error({ code: "invalid", message: "Choose task IDs or all, not both." })
      if (input.reason && input.reason.length > 1000)
        return yield* new Error({ code: "invalid", message: "Stop reasons are limited to 1000 characters." })
      const { tasks } = yield* halt({ ...input, origin: input.origin ?? "agent" }, ops)
      return { tasks }
    })

    const interrupt: Interface["interrupt"] = Effect.fn("TaskManager.interrupt")(function* (input, ops) {
      if (input.reason && input.reason.length > 1000)
        return yield* new Error({ code: "invalid", message: "Stop reasons are limited to 1000 characters." })
      const session = yield* get(input.sessionID)
      // Fenced before anything stops: a helper that finishes meanwhile, or whose note is already held, is recorded
      // without starting a turn until the user writes again (I5).
      yield* notify.fence(session.id)
      const aborted = (yield* statuses.get(session.id)).type !== "idle"
      yield* ops.cancel(session.id)
      if (!input.helpers) return { aborted, tasks: [], shells: 0, excluded: 0, skipped: 0 }
      const stopped = new Map<string, Task.Info>()
      let board: readonly Task.Info[] = []
      for (let sweep = 0; sweep < SWEEPS; sweep++) {
        const result = yield* halt(
          { sessionID: session.id, all: true, reason: input.reason, origin: "user", helpers: true },
          ops,
        )
        board = result.board
        const fresh = result.tasks.filter((task) => !stopped.has(task.id))
        result.tasks.forEach((task) => stopped.set(task.id, task))
        // Background commands stop here too once they exist (WP33).
        if (fresh.length === 0) break
      }
      // Desktop workspaces and swarms keep their own runners and are left running; the ones Vector cannot reach
      // right now are counted apart.
      const left = board.filter((task) => !helper(task))
      return {
        aborted,
        tasks: [...stopped.values()],
        shells: 0,
        excluded: left.filter((task) => task.connection !== "disconnected").length,
        skipped: left.filter((task) => task.connection === "disconnected").length,
      }
    })

    // Move to background (5.D.2): each of a root session's running foreground subagents, a batch's entries included,
    // keeps running, the call that waited on it returns, and it reports later in its own note.
    const promote: Interface["promote"] = Effect.fn("TaskManager.promote")(function* (input) {
      if (input.taskIDs && (input.taskIDs.length === 0 || input.taskIDs.length > MAX_TASKS))
        return yield* new Error({ code: "invalid", message: "Choose 1–200 task IDs." })
      const session = yield* get(input.sessionID)
      if (session.parentID || !flags.backgroundSubagents) return { tasks: [] }
      const wanted = input.taskIDs && new Set(input.taskIDs)
      const foreground = (yield* jobs.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === session.id &&
          job.metadata.background !== true &&
          (!wanted || wanted.has(job.id)),
      )
      const promoted = yield* Effect.forEach(foreground, (job) => jobs.promote(job.id), { concurrency: "unbounded" })
      const tasks = yield* Effect.forEach(
        promoted.flatMap((job) => (job?.metadata?.background === true ? [SessionID.make(job.id)] : [])),
        (id) =>
          get(id).pipe(
            Effect.flatMap((child) => (SubagentLifecycle.read(child) ? observe(child) : Effect.succeed(undefined))),
            Effect.catchTag("TaskManager.Error", () => Effect.succeed(undefined)),
          ),
        { concurrency: 4 },
      )
      return { tasks: tasks.filter((task) => task !== undefined) }
    })

    // Resume checks one child (D.3 checks 1 to 9): a direct child of the root, not running here or in another live
    // engine, finished as stopped or failed (completed only from the user, with a message), not a research agent, started,
    // not dismissed, its launch message kept, and for the agent, the user asked after it was interrupted or stopped.
    const resumable = Effect.fn("TaskManager.resumable")(function* (
      root: Session.Info,
      taskID: string,
      origin: "agent" | "user",
      text: string | undefined,
    ) {
      const found = yield* requireTask(root.id, taskID)
      if (SubagentLifecycle.read(found)?.workflow)
        return yield* new Error({
          code: "invalid",
          message: "Resume workflow runs through workflow so their plan and cumulative limits are checked.",
        })
      if (found.parentID !== root.id)
        return yield* new Error({
          code: "invalid",
          message: "Only helpers the main agent launched resume this way; resume the helper that launched this one.",
        })
      // A record whose engine is gone is settled first, as the board settles it.
      yield* observe(found)
      const session = yield* get(found.id)
      const record = SubagentLifecycle.read(session)!
      const running = new Error({ code: "running", message: "This task is still running; send it a message instead." })
      const privateWork = yield* isolated(isolation.find(session.id))
      if (privateWork && ["running", "settling"].includes(privateWork.state)) return yield* running
      // The launch assignment is durable in the record; a child stopped before its slot has no checkout yet.
      const assigned = privateWork !== undefined || record.isolation !== undefined
      if (assigned) {
        const resolved = yield* agents.get(record.agent)
        if (!resolved) return yield* new Error({ code: "invalid", message: "The task's agent is no longer available." })
        yield* isolated(isolation.check({ parentSessionID: root.id, agent: resolved, resumeID: session.id }))
      }
      if ((yield* jobs.get(session.id))?.status === "running" || SubagentLifecycle.stopping.has(session.id))
        return yield* running
      if (!SubagentLifecycle.ownedHere(record)) {
        const owner = yield* SubagentLifecycle.liveness(store, session, record)
        // The user is asked to confirm an owner Vector cannot reach; the agent never resumes one.
        if (owner === "alive" || (owner === "unknown" && origin === "agent"))
          return yield* new Error({
            code: "running",
            message:
              owner === "alive"
                ? "Another Vector process is still running this task."
                : "Another Vector process may still be running this task; ask the user before resuming it.",
          })
      }
      if (record.status === "completed" && origin === "agent")
        return yield* new Error({
          code: "finished",
          message: "This task completed; to give it more work, call task with its task_id and a new brief.",
        })
      if (record.status === "completed" && !text)
        return yield* new Error({ code: "invalid", message: "A completed task continues only with a message." })
      if (SubagentLifecycle.open(record)) return yield* running
      if (RESEARCH_AGENTS.has(record.agent))
        return yield* new Error({ code: "invalid", message: "A research agent cannot be resumed; start a new one." })
      // A fork resumes only while forks may start: it sends its whole inherited window again (5.E.3).
      if (record.fork && (yield* config.get()).sizing?.subagents?.fork === false)
        return yield* new Error({ code: "invalid", message: SessionFork.TURNED_OFF })
      if (
        record.fork &&
        Permission.evaluate("task", "fork", (yield* agents.get(record.agent))?.permission ?? [], root.permission ?? [])
          .action === "deny"
      )
        return yield* new Error({ code: "forbidden", message: SessionFork.denied(record.agent) })
      if (Option.isNone(yield* sessions.findMessage(session.id, SessionTaskSize.real).pipe(Effect.orDie)))
        return yield* new Error({ code: "invalid", message: "This task never started; relaunch it with task." })
      if (record.interruption?.dismissedAt !== undefined)
        return yield* new Error({
          code: "invalid",
          message: "This task was dismissed; relaunch it with task if needed.",
        })
      if (!(yield* SubagentLifecycle.written(database, root.id, record.parentMessageID)))
        return yield* new Error({
          code: "invalid",
          message: "The message that launched this task was reverted; relaunch it with task if needed.",
        })
      if (origin === "agent" && !(yield* SubagentLifecycle.agentMayResume(sessions, root.id, record)))
        return yield* new Error({ code: "forbidden", message: SubagentLifecycle.HUMAN_FIRST })
      return { session, record, assigned }
    })

    // Resume (D.3): every child is checked, its owned paths are free and its admission taken before any of them starts.
    const resume: Interface["resume"] = Effect.fn("TaskManager.resume")(function* (input, ops) {
      const ids = [...new Set(input.taskIDs)]
      if (ids.length === 0 || ids.length > MAX_RESUME)
        return yield* new Error({ code: "invalid", message: `Choose 1–${MAX_RESUME} task IDs.` })
      const text = input.text?.trim() || undefined
      const invalid = text === undefined ? undefined : TaskMailbox.bodyError(text)
      if (invalid) return yield* new Error({ code: "invalid", message: invalid })
      const root = yield* get(input.sessionID)
      if (root.parentID)
        return yield* new Error({
          code: "forbidden",
          message: "Only the main agent resumes helpers this way; continue your own child with task and its task_id.",
        })
      if (!flags.backgroundSubagents)
        return yield* new Error({
          code: "invalid",
          message: "Background subagents are turned off (VECTOR_DISABLE_BACKGROUND_SUBAGENTS), so nothing can resume.",
        })
      // What the main agent took in travels with its words to the child (D.6); the user's own words carry nothing.
      const carried =
        input.origin === "agent" && text
          ? SessionMemory.carried(
              SessionMemory.taint(
                yield* sessions
                  .messages({ sessionID: root.id })
                  .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[]))),
              ),
            )
          : {}
      const guest = input.guest || (yield* guests.marked(root.id))
      const conversationID = yield* TaskLimits.conversationOf(sessions, root, guest)
      const requestID = yield* TaskLimits.requestFor(limits, sessions, SessionID.make(conversationID))
      const resolved = TaskLimits.resolve(yield* config.get(), guest)
      const directory = yield* InstanceState.directory
      const started = yield* SubagentLifecycle.locked(lock)(
        Effect.scoped(
          Effect.gen(function* () {
            const checked = yield* Effect.forEach(ids, (id) => resumable(root, id, input.origin, text))
            const resuming = new Set<string>(checked.map((item) => item.session.id))
            const instance = yield* InstanceState.context
            const conflicts = new Set(
              yield* TaskClaims.describe(
                checked.flatMap(({ record, session, assigned }) =>
                  assigned
                    ? []
                    : TaskClaims.overlaps({
                        tree: instance.worktree,
                        directory,
                        parentSessionID: root.id,
                        taskID: session.id,
                        paths: record.ownedPaths ?? [],
                        except: resuming,
                      }),
                ),
                // Another conversation's claim is named only to its family; a family that cannot be read names none.
                TaskClaims.familyOf(audience, root.id),
              ),
            )
            // Resuming siblings must not acquire overlapping assignments in the same batch either.
            for (const [index, item] of checked.entries()) {
              for (const other of checked.slice(0, index)) {
                if (item.assigned || other.assigned) continue
                for (const owned of item.record.ownedPaths ?? []) {
                  for (const existing of other.record.ownedPaths ?? []) {
                    if (TaskClaims.pathsOverlap(path.resolve(directory, owned), path.resolve(directory, existing)))
                      conflicts.add(`${other.record.title}: ${owned} overlaps ${existing}`)
                  }
                }
              }
            }
            if (conflicts.size > 0)
              return yield* new Error({
                code: "conflict",
                message: [
                  "Owned paths overlap active work:",
                  ...[...conflicts].map((item) => `- ${item}`),
                  "Wait for that task or stop it first.",
                ].join("\n"),
              })
            const admitted = yield* Effect.forEach(checked, (item) =>
              limits.admit({ conversationID, requestID, limits: resolved, origin: "resume", count: 1 }).pipe(
                Effect.map((admission) => ({ ...item, admission })),
                Effect.mapError((refused) => new Error({ code: "limit", message: refused.message })),
              ),
            )
            const delegated = {
              id: TaskLimits.ledger(conversationID, requestID),
              budget: resolved.budget,
              seed: yield* limits.seed(conversationID, requestID),
            }
            return yield* Effect.forEach(admitted, ({ session, record: ran, admission }) =>
              Effect.gen(function* () {
                const id = session.id
                const attempt = (ran.attempt ?? 1) + 1
                // A resume keeps the effort the child ran at while its cache is warm; after that the child runs at its
                // model's own effort, without a variant that only its brief's effort set (5.E.1). A fork keeps its
                // parent's request, as the task tool resumes it.
                const cold =
                  !ran.fork &&
                  ran.effort !== undefined &&
                  !SubagentModel.warm(
                    ran,
                    yield* provider
                      .getModel(ProviderV2.ID.make(ran.model.providerID), ModelV2.ID.make(ran.model.modelID))
                      .pipe(Effect.catch(() => Effect.succeed(undefined))),
                  )
                const record: SubagentRecord = cold
                  ? {
                      ...ran,
                      effort: undefined,
                      model:
                        ran.effort !== "default" && ran.model.variant === ran.effort
                          ? { providerID: ran.model.providerID, modelID: ran.model.modelID }
                          : ran.model,
                    }
                  : ran
                const now = Date.now()
                const lease = yield* TaskJobs.atLauncher(session)(jobs.lease())
                let queued = admission.waits
                yield* guard.link(id, root.id, { budget: record.budget, renew: true, delegated })
                yield* persist(
                  id,
                  {
                    ...(cold ? { effort: undefined, model: record.model } : {}),
                    attempt,
                    status: queued ? "queued" : "running",
                    slotReason: queued ? TaskLimits.SLOT_REASON : undefined,
                    background: true,
                    startedAt: now,
                    runtimeID: lease?.runtime ?? SubagentLifecycle.RUNTIME_ID,
                    owner: lease ? { pid: lease.pid, boot: lease.boot } : undefined,
                    conversationID,
                    rootSessionID: root.id,
                    requestID,
                    completedAt: undefined,
                    usage: undefined,
                    budgetScopes: undefined,
                    error: undefined,
                    notification: undefined,
                    resultRef: undefined,
                    resultSummary: undefined,
                    reason: undefined,
                    ...(record.interruption && { interruption: { ...record.interruption, resumedAt: now } }),
                    stop: undefined,
                    waiting: undefined,
                    reports: undefined,
                    // The schema applies to this run too, which counts its own attempts (5.E.2).
                    ...(record.structured && {
                      structured: {
                        schema: record.structured.schema,
                        schemaHash: record.structured.schemaHash,
                        attempts: 0,
                      },
                    }),
                  },
                  record.attempt,
                )
                const brief = [
                  ...(record.status === "completed"
                    ? []
                    : [
                        record.stop?.by === "user"
                          ? SubagentLifecycle.RESUME_STOPPED_BRIEF
                          : record.interruption && record.interruption.resumedAt === undefined
                            ? SubagentLifecycle.RESUME_BRIEF
                            : SubagentLifecycle.RESUME_ENDED_BRIEF,
                      ]),
                  ...(text ? [TaskMailbox.envelope(text, { sender: root.id, recipient: id, relation: "parent" })] : []),
                ].join("\n\n")
                const execute = Effect.gen(function* () {
                  // Queued for a slot until now; running clears the reason.
                  if (queued) {
                    queued = false
                    yield* SubagentLifecycle.update(sessions, id, { status: "running", slotReason: undefined }, attempt)
                  }
                  const since = MessageID.ascending()
                  const shaped = yield* shape(record)
                  const structured = record.structured && !record.fork ? record.structured : undefined
                  const result = yield* ops.prompt({
                    sessionID: id,
                    messageID: since,
                    agent: record.agent,
                    ...shaped.request,
                    ...(structured ? { format: TaskStructured.format(structured.schema) } : {}),
                    parts: [
                      {
                        type: "text",
                        synthetic: true,
                        // A fork answers in a ```json block, so every prompt into it repeats the schema (5.E.2).
                        text:
                          record.fork && record.structured
                            ? `${brief}\n\n${SessionFork.answerIn(record.structured.schema)}`
                            : brief,
                        ...(Object.keys(carried).length > 0 ? { metadata: carried } : {}),
                      },
                    ],
                  })
                  if (!record.structured) return result
                  return (yield* TaskStructured.settle({
                    sessions,
                    ops,
                    sessionID: id,
                    ...shaped.settle,
                    agent: record.agent,
                    schema: record.structured.schema,
                    mode: structured ? "tool" : "text",
                    since,
                    result,
                    attempt,
                  })).json
                })
                const privateWork = yield* isolated(isolation.find(id))
                const assigned = privateWork !== undefined || record.isolation !== undefined
                const work = Effect.gen(function* () {
                  if (assigned) {
                    const resolved = yield* agents.get(record.agent)
                    if (!resolved)
                      return yield* Effect.fail(new globalThis.Error("The task's agent is no longer available."))
                    // An assigned child that never reached its slot is reserved now, as its first run would have been.
                    const started = privateWork
                      ? (yield* isolation.resume({ taskID: id, attempt, agent: resolved })).record
                      : (yield* isolation
                          .reserve({
                            taskID: id,
                            parentSessionID: root.id,
                            agent: resolved,
                            title: record.title,
                            attempt,
                            dependsOn: record.dependsOn,
                          })
                          .pipe(Effect.andThen(isolation.start(id)))).record
                    yield* persist(id, { isolation: TaskIsolation.info(started) }, attempt)
                  }
                  return yield* TaskPlace.within(id)(execute)
                })
                const complete = (job: BackgroundJob.Info) =>
                  !assigned
                    ? Effect.void
                    : TaskIsolation.complete({
                        isolation,
                        taskID: id,
                        attempt,
                        status: job.status,
                        scope,
                        mirror: (saved) => persist(id, { isolation: TaskIsolation.info(saved) }, attempt),
                      }).pipe(Effect.provideService(InstanceRef, instance))
                const waiting = Effect.sync(() => {
                  queued = true
                }).pipe(
                  Effect.andThen(
                    SubagentLifecycle.update(
                      sessions,
                      id,
                      { status: "queued", slotReason: TaskLimits.SLOT_REASON },
                      attempt,
                    ),
                  ),
                )
                const ownership = yield* TaskClaims.scoped({
                  tree: instance.worktree,
                  directory,
                  parentSessionID: root.id,
                  taskID: id,
                  title: record.title,
                  paths: record.ownedPaths ?? [],
                  writes: !Agent.readOnly(record.agent),
                  isolated: assigned,
                })
                const claim = ownership.claim
                TaskClaims.bind(claim, id)
                yield* limits.bind(admission, id)
                // A fork's prefix stays while it runs (5.E.3).
                if (record.fork) yield* forks.hold(MessageID.make(record.fork.point), id)
                yield* jobs
                  .start({
                    id,
                    type: "task",
                    title: record.title,
                    metadata: {
                      parentSessionId: root.id,
                      sessionId: id,
                      projectId: root.projectID,
                      directory: root.directory,
                      model: record.model,
                      kind: record.kind,
                      agent: record.agent,
                      custom: record.custom,
                      title: record.title,
                      parentMessageId: record.parentMessageID,
                      startedAt: now,
                      attempt,
                      ...(record.ownedPaths?.length ? { ownedPaths: record.ownedPaths } : {}),
                      background: true,
                    },
                    // A row in vector.db, so a restart can tell the parent this child was interrupted again.
                    durable: { parentSessionID: root.id, sessionID: id, directory, attempt },
                    ...(assigned ? { onComplete: complete } : {}),
                    run: limits.run({ conversationID, childID: id, origin: "resume", waiting }, work).pipe(
                      Effect.onInterrupt(() => ops.cancel(id)),
                      Effect.flatMap((ran) =>
                        typeof ran === "string" ? Effect.succeed(ran) : SubagentLifecycle.settleRun(ran),
                      ),
                      Effect.ensuring(limits.release(admission, id)),
                      Effect.ensuring(record.fork ? forks.release(id) : Effect.void),
                    ),
                  })
                  .pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        yield* jobs
                          .wait({ id })
                          .pipe(
                            Effect.ensuring(Effect.sync(() => TaskClaims.release(claim))),
                            Effect.ignore,
                            Effect.forkIn(scope, { startImmediately: true }),
                          )
                        ownership.started = true
                      }),
                    ),
                    Effect.uninterruptible,
                  )
                yield* notify.watch({
                  jobID: id,
                  parentID: root.id,
                  taskID: id,
                  attempt,
                  title: record.title,
                  startedAt: now,
                  launchID: MessageID.make(record.parentMessageID),
                  ops,
                  agent: root.agent ?? "build",
                })
                return id
              }),
            )
          }),
        ),
      )
      return {
        tasks: yield* Effect.forEach(started, (id) => get(id).pipe(Effect.flatMap(observe)), { concurrency: 4 }),
      }
    })

    const wait: Interface["wait"] = Effect.fn("TaskManager.wait")(function* (input) {
      if (
        !Number.isFinite(input.timeout ?? 30_000) ||
        (input.timeout ?? 30_000) < 0 ||
        (input.timeout ?? 30_000) > 60_000
      )
        return yield* new Error({ code: "invalid", message: "Wait timeout must be between 0 and 60000 milliseconds." })
      const before = yield* SubagentLifecycle.locked(lock)(select(input.sessionID, input.taskIDs))
      const settled = (tasks: readonly Task.Info[]) =>
        input.mode === "all"
          ? tasks.every((task) => !ACTIVE.has(task.status))
          : tasks.some((task) => !ACTIVE.has(task.status))
      if (settled(before)) return { tasks: before, timedOut: false }
      const waits = before
        .filter((task) => ACTIVE.has(task.status))
        .map((task) =>
          DesktopTasks.owns(task.id)
            ? bridge(desktop.wait({ sessionID: input.sessionID, taskID: task.id, timeout: input.timeout ?? 30_000 }))
            : jobs.wait({ id: task.id }).pipe(Effect.asVoid),
        )
      const finished = (
        input.mode === "all" ? Effect.all(waits, { concurrency: "unbounded", discard: true }) : Effect.raceAll(waits)
      ).pipe(Effect.as<string[]>([]))
      // A selected task that starts waiting on the user ends the wait early, so the agent can tell the user (D.4). One
      // already waiting does not, or every wait on it would return at once.
      const asking = signals.next(
        before.filter((task) => ACTIVE.has(task.status) && !DesktopTasks.owns(task.id)).map((task) => task.id),
      )
      const done = yield* Effect.raceFirst(finished, asking).pipe(Effect.timeoutOption(input.timeout ?? 30_000))
      const tasks = yield* select(input.sessionID, input.taskIDs)
      const attention = Option.getOrElse(done, () => [])
      return {
        tasks,
        timedOut: Option.isNone(done) || (attention.length === 0 && !settled(tasks)),
        ...(attention.length > 0 ? { attention } : {}),
      }
    })

    return Service.of({
      list: list as Interface["list"],
      inspect,
      changes,
      counts,
      merge,
      discard,
      message,
      report,
      stop,
      interrupt,
      promote,
      resume,
      wait,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    BackgroundJob.node,
    SessionStatus.node,
    Permission.node,
    Question.node,
    Database.node,
    SpendGuard.node,
    DesktopTasks.node,
    TaskLimits.node,
    Config.node,
    FreeModelGuests.node,
    BackgroundJobStore.node,
    TaskNotify.node,
    RuntimeFlags.node,
    TaskSignals.node,
    SessionFork.node,
    Provider.node,
    Agent.node,
    TaskIsolation.node,
    SessionAudience.node,
  ],
})
export * as TaskManager from "./manager"
