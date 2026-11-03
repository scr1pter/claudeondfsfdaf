import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"
import { Context, Effect, Fiber, Layer, Option, Scope, Semaphore } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { TaskSize } from "@vectordevai/core/task-size"
import type { SubagentInterruptionCause, SubagentRecord } from "@/agent/subagent-kind"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceHooks } from "@/project/instance-hooks"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { TaskNotify } from "./notify"
import { TaskIsolation } from "./isolation"
import { TaskPlace } from "./place"
import { ShellJobs } from "./shells"

/*
 * Restart recovery (D.3). When an instance boots, and every 5 minutes after, the helpers whose engine stopped (an
 * update, restart or crash) are settled as interrupted, and each root conversation gets one quiet note naming them,
 * with any report that finished but never reached it. Nothing restarts on its own, and the note starts no model
 * request.
 */

export interface Interface {
  /** One pass over this instance's directory. `reported` counts the helpers it newly reported as interrupted. */
  readonly reconcile: () => Effect.Effect<{ reported: number }>
}

export class Service extends Context.Service<Service, Interface>()("@vector/TaskRecovery") {}

/** The InstanceHooks name recovery runs under at every instance boot. */
export const HOOK = "task-recovery"
const INTERVAL = "5 minutes"
// Ended rows are kept, and older Vector's helpers and undelivered reports looked for, this long.
const KEEP = 7 * 24 * 60 * 60 * 1000
// How long an instance's boot waits for its first pass; the pass itself carries on.
const BOOT_WAIT = "10 seconds"

/** An interrupted helper as the note lists it, under the session that launched it. */
export type Helper = { id: string; title: string; parentID: string }

/** The recovery note's text: each helper the root launched, with the ones it launched in turn under it. */
export function note(helpers: readonly Helper[], rootID: string) {
  const line = (helper: Helper, indent = "") => `${indent}- "${TaskSize.titled(helper.title)}" (${helper.id})`
  const listed = new Set(helpers.map((helper) => helper.id))
  const lines = helpers.flatMap((helper) => {
    if (helper.parentID === rootID)
      return [line(helper), ...helpers.filter((item) => item.parentID === helper.id).map((item) => line(item, "  "))]
    return listed.has(helper.parentID) ? [] : [`${line(helper)}, launched by ${helper.parentID}`]
  })
  return [
    "Vector stopped while these helpers were working (an update, restart or crash):",
    ...lines,
    "Nothing restarts on its own. Ask the user before resuming them; resume with task_manage resume, or relaunch helpers that never started.",
  ].join("\n")
}

// A record recovery still has to report: in flight, or settled by TaskManager.observe without a report.
function unreported(record: SubagentRecord) {
  if (SubagentLifecycle.open(record)) return true
  const interruption = record.interruption
  return (
    record.status === "cancelled" &&
    interruption !== undefined &&
    interruption.reportedAt === undefined &&
    interruption.resumedAt === undefined
  )
}

type Found = { child: Session.Info; record: SubagentRecord }
type Group = { root: Session.Info; helpers: Helper[]; notes: TaskNotify.Note[] }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const sessions = yield* Session.Service
    const store = yield* BackgroundJobStore.Service
    const database = yield* Database.Service
    const notify = yield* TaskNotify.Service
    const isolation = yield* TaskIsolation.Service
    const guard = yield* SpendGuard.Service
    const prompts = yield* SessionPrompt.Service
    const hooks = yield* InstanceHooks.Service
    const ops: TaskPromptOps = {
      cancel: (sessionID) => prompts.cancel(sessionID),
      resolvePromptParts: (template) => prompts.resolvePromptParts(template),
      prompt: (input) => prompts.prompt(input).pipe(Effect.catch(Effect.die)),
    }
    // One pass at a time in this process; engines sharing vector.db are kept apart by the row claims.
    const lock = Semaphore.makeUnsafe(1)

    const find = (id: SessionID) => sessions.get(id).pipe(Effect.option, Effect.map(Option.getOrUndefined))
    const exists = (sessionID: SessionID, messageID: string) =>
      MessageV2.get({ sessionID, messageID: MessageID.make(messageID) }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.option,
        Effect.map(Option.isSome),
      )

    // The root conversation above a helper, at most two levels up.
    const rootOf = Effect.fnUntraced(function* (child: Session.Info) {
      let current = child
      for (let depth = 0; current.parentID && depth < 3; depth++) {
        const parent = yield* find(current.parentID)
        if (!parent) return undefined
        current = parent
      }
      return current.parentID ? undefined : current
    })

    // Settles an interrupted helper's record and the tool part that launched it, for the attempt that stopped.
    const settle = Effect.fnUntraced(function* (
      childID: SessionID,
      attempt: number | undefined,
      cause: SubagentInterruptionCause,
      at: number,
      now: number,
    ) {
      const child = yield* find(childID)
      const record = child && SubagentLifecycle.read(child)
      if (!child || !record || (attempt !== undefined && record.attempt !== attempt) || !unreported(record))
        return undefined
      const usage = (yield* SubagentLifecycle.observe(sessions, childID))?.usage
      // A helper this process ran (an instance it disposed) still has its spend binding here, as finish would release.
      const scopes = yield* guard.scopes(childID)
      yield* SubagentLifecycle.write(
        sessions,
        childID,
        {
          status: "cancelled",
          completedAt: at,
          ...(usage ? { usage } : {}),
          ...(scopes.length > 0 ? SubagentLifecycle.scopeFields(scopes) : {}),
          reason: SubagentLifecycle.INTERRUPTED_REASON,
          slotReason: undefined,
          // An earlier mark of this same stop (observe's) may be older; an interruption already resumed is another stop.
          interruption: {
            at:
              record.interruption && record.interruption.resumedAt === undefined
                ? Math.min(at, record.interruption.at)
                : at,
            cause,
            reportedAt: now,
          },
        },
        record.attempt,
      )
      yield* guard.release(childID)
      if (record.callID)
        yield* SubagentLifecycle.settleOrphanPart({
          sessions,
          messageID: MessageID.make(record.parentMessageID),
          callID: record.callID,
          ...(record.batchIndex === undefined ? {} : { index: record.batchIndex }),
        }).pipe(Effect.provideService(Database.Service, database))
      return { child, record } satisfies Found
    })

    // This directory's helper sessions from the last 7 days that recovery may act on: open or unreported ones, and
    // report notes, at boot every one, later only those nothing has claimed.
    const scan = Effect.fnUntraced(function* (ctx: InstanceContext, now: number, boot: boolean) {
      const field = (path: string) => sql`json_extract(${SessionTable.metadata}, ${`$.subagent${path}`})`
      const wanted = or(
        inArray(field(".status"), ["running", "queued"]),
        and(isNotNull(field(".interruption")), isNull(field(".interruption.reportedAt"))),
        boot
          ? isNotNull(field(".notification.text"))
          : and(isNotNull(field(".notification.text")), isNull(field(".notification.messageID"))),
      )
      const rows = yield* database.db
        .select()
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.project_id, ctx.project.id),
            eq(SessionTable.directory, ctx.directory),
            isNotNull(SessionTable.parent_id),
            isNull(SessionTable.internal),
            gte(SessionTable.time_updated, now - KEEP),
            wanted,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.flatMap((row): Found[] => {
        const child = Session.fromRow(row)
        const record = SubagentLifecycle.read(child)
        return record ? [{ child, record }] : []
      })
    })

    // A finished helper's report that never reached its root, from an engine that is gone: claimed when its note is
    // delivered, so a human prompt recovering it at the same time takes it at most once between them.
    const undelivered = Effect.fnUntraced(function* ({ child, record }: Found, root: Session.Info) {
      const stored = record.notification
      if (!stored || SubagentLifecycle.ownedHere(record)) return undefined
      if ((yield* SubagentLifecycle.liveness(store, child, record)) !== "dead") return undefined
      const stale = stored.messageID
      if (
        stale &&
        ((stored.claimedAt ?? 0) > Date.now() - SubagentLifecycle.CLAIM_GRACE || (yield* exists(root.id, stale)))
      )
        return undefined
      if (!(yield* exists(root.id, stored.launchID))) {
        yield* SubagentLifecycle.write(sessions, child.id, { notification: undefined }, record.attempt)
        return undefined
      }
      return {
        kind: "result",
        taskID: child.id,
        launchID: MessageID.make(stored.launchID),
        attempt: record.attempt,
        state: stored.state,
        text: stored.text,
        wake: false,
        quiet: true,
        recovered: true,
        ...(stale ? { stale } : {}),
      } satisfies TaskNotify.Note
    })

    const pass = Effect.fn("TaskRecovery.reconcile")(function* (boot: boolean) {
      const ctx = yield* InstanceState.context
      const now = Date.now()
      const found: Found[] = []
      const each = <A>(items: readonly A[], work: (item: A) => Effect.Effect<Found | undefined, unknown>) =>
        Effect.forEach(
          items,
          (item) =>
            work(item).pipe(
              Effect.tap((settled) => Effect.sync(() => settled && found.push(settled))),
              Effect.catchCause((cause) => Effect.logWarning("an interrupted helper was not recovered", { cause })),
            ),
          { discard: true },
        )

      // Rows whose work stopped: running under a dead owner, or interrupted. Each is claimed once across every engine
      // on this database. A background command's row is reported to the session that started it (5.H); Vector never
      // stops its process, which it can no longer see.
      const commands: BackgroundJobStore.Candidate[] = []
      yield* each(yield* store.candidates(ctx.directory), (row) =>
        row.type === "shell"
          ? store.claim(row, now).pipe(
              Effect.map((claimed) => {
                if (claimed) commands.push(row)
                return undefined
              }),
            )
          : row.type !== "task"
            ? Effect.succeed(undefined)
            : store
                .claim(row, now)
                .pipe(
                  Effect.flatMap((claimed) =>
                    claimed
                      ? settle(
                          SessionID.make(row.sessionID ?? row.id),
                          row.attempt,
                          row.cause,
                          row.completedAt ?? now,
                          now,
                        )
                      : Effect.succeed(undefined),
                  ),
                ),
      )

      const records = yield* scan(ctx, now, boot)
      // Helpers an older Vector left running: they have no row, so one is inserted to report them once. An older Vector
      // keeps no lease, so its open work counts as stopped only once its session has been idle (LEGACY_IDLE).
      yield* each(
        records.filter(
          ({ child, record }) =>
            unreported(record) &&
            !(record.runtimeID ?? "").includes(":") &&
            SubagentLifecycle.localLiveness(record, child.time.updated) === "dead",
        ),
        ({ child, record }) =>
          store
            .insertLegacy({
              id: child.id,
              type: "task",
              title: record.title,
              parentSessionID: record.parentSessionID,
              sessionID: child.id,
              directory: ctx.directory,
              background: record.background,
              ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
              startedAt: record.startedAt,
              runtime: record.runtimeID ?? "",
              at: now,
            })
            .pipe(
              Effect.flatMap((inserted) =>
                inserted ? settle(child.id, record.attempt, "unknown", now, now) : Effect.succeed(undefined),
              ),
            ),
      )

      // One note per root: the interrupted helpers, then the reports recovered for it.
      const groups = new Map<string, Group>()
      const group = (root: Session.Info) => {
        const existing = groups.get(root.id)
        if (existing) return existing
        const created: Group = { root, helpers: [], notes: [] }
        groups.set(root.id, created)
        return created
      }
      for (const { child, record } of found.toSorted((a, b) => a.record.startedAt - b.record.startedAt)) {
        const root = yield* rootOf(child)
        if (root && child.parentID)
          group(root).helpers.push({ id: child.id, title: record.title, parentID: child.parentID })
      }
      // A background command's note goes to the conversation that started it: the main agent's own session.
      yield* Effect.forEach(
        commands,
        (row) =>
          Effect.gen(function* () {
            const parent = yield* find(SessionID.make(row.parentSessionID))
            const root = parent && (parent.parentID ? yield* rootOf(parent) : parent)
            if (!root) return
            group(root).notes.push({
              kind: "shell",
              shellID: row.id,
              state: "interrupted",
              text: ShellJobs.interrupted(row),
              wake: false,
              quiet: true,
              recovered: true,
            })
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("an interrupted background command was not reported", { cause }),
            ),
          ),
        { discard: true },
      )
      yield* Effect.forEach(
        records.filter(({ record }) => record.notification !== undefined),
        (item) =>
          Effect.gen(function* () {
            const parent = item.child.parentID ? yield* find(item.child.parentID) : undefined
            // A nested helper's report reaches its own parent when that parent resumes.
            if (!parent || parent.parentID || parent.time.archived !== undefined) return
            const recovered = yield* undelivered(item, parent)
            if (recovered) group(parent).notes.push(recovered)
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("a helper's report was not recovered", { cause }))),
        { discard: true },
      )

      // An archived conversation keeps its records settled and reported, and gets no note. The notes are written now,
      // not held in a window: a short-lived command (`vector mcp list`) exits before a window would send them.
      yield* Effect.forEach(
        [...groups.values()].filter((item) => item.root.time.archived === undefined),
        ({ root, helpers, notes }) =>
          notify.post({
            parentID: root.id,
            notes: [
              ...(helpers.length > 0
                ? [
                    {
                      kind: "interrupted",
                      taskIDs: helpers.map((helper) => SessionID.make(helper.id)),
                      state: "interrupted",
                      text: note(helpers, root.id),
                      wake: false,
                      quiet: true,
                    } satisfies TaskNotify.Note,
                  ]
                : []),
              ...notes,
            ],
            ops,
            agent: root.agent ?? "build",
          }),
        { discard: true },
      )

      yield* store.prune(now - KEEP)
      return { reported: found.length }
    })

    // Isolated work is reconciled only once nothing can still be running it. The task's job row for this attempt (or a
    // later one) names the lease that runs it; while that lease (this process's or another engine's on this data
    // folder) is alive or cannot be judged, the record is left alone, so a slow start or another engine's running
    // checkout is never saved and retired under it. The row is written after the child's record, within a bound, and a
    // failed write is only logged, so without one the child's record decides, as it does for the helper itself: its
    // owner for this attempt must be gone. A failed save is retried at boot only, not every pass. Merges and discards
    // interrupted part-way are finished at boot.
    const recoverIsolations = Effect.fn("TaskRecovery.isolations")(function* (boot: boolean) {
      for (const record of yield* isolation.records())
        yield* Effect.gen(function* () {
          const jobDriven =
            ["preparing", "running", "settling"].includes(record.state) ||
            (record.state === "failed" && (boot || record.settledAttempt !== record.attempt))
          const interrupted =
            record.state === "discarding" || (record.mergeStartedAt !== undefined && !record.mergeCompleted)
          if (!jobDriven && !(boot && interrupted)) return
          if (jobDriven) {
            const row = (yield* store.forParent(record.parentSessionID)).find(
              (item) =>
                item.type === "task" &&
                (item.sessionID ?? item.id) === record.taskID &&
                (item.attempt ?? 0) >= record.attempt,
            )
            if (row && BackgroundJobStore.alive(row.owner) !== "dead") return
            if (!row) {
              // A deleted child has no record left to judge by; nothing can be running a conversation that is gone.
              const child = yield* find(SessionID.make(record.taskID))
              const lifecycle = child && SubagentLifecycle.read(child)
              if (child && (!lifecycle || (lifecycle.attempt ?? 1) < record.attempt)) return
              if (child && lifecycle && (yield* SubagentLifecycle.liveness(store, child, lifecycle)) !== "dead") return
            }
          }
          // Fencing is idempotent; it keeps a record made before the fence existed owner-only before its reconcile can
          // report anything. Only a record about to be reconciled is fenced, so settled records, which the registry
          // keeps, cost no write transaction on every pass.
          yield* isolation.fence(record.taskID)
          yield* isolation.reconcile(record.taskID)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("an isolated task was not recovered", { taskID: record.taskID, cause }),
          ),
        )
      yield* isolation
        .sweep()
        .pipe(Effect.catchCause((cause) => Effect.logWarning("isolated task sweep failed", { cause })))
    })
    // Inside a task's own checkout there is nothing to recover: its launcher's home does that. An unreadable isolation
    // registry never keeps ordinary interrupted helpers from being reported.
    const run = (boot: boolean) =>
      InstanceState.context.pipe(
        Effect.flatMap((context) =>
          TaskPlace.isTaskDirectory(context.directory)
            ? Effect.succeed({ reported: 0 })
            : recoverIsolations(boot).pipe(
                Effect.catchCause((cause) => Effect.logWarning("isolated task recovery failed", { cause })),
                Effect.andThen(SubagentLifecycle.locked(lock)(pass(boot))),
              ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("task recovery failed", { cause }).pipe(Effect.as({ reported: 0 })),
        ),
      )

    // Each instance checks again every 5 minutes, for engines on this database that stopped meanwhile.
    const loops = yield* InstanceState.make(
      Effect.fnUntraced(function* () {
        yield* Effect.sleep(INTERVAL).pipe(
          Effect.andThen(run(false)),
          Effect.forever,
          Effect.forkScoped({ startImmediately: true }),
        )
      }),
    )

    // At boot the instance waits a little for the first pass, so its helpers are settled and their notes queued before its
    // sessions are read. The pass runs outside the boot, so a slow one is never cut short with its rows claimed and its
    // notes unsent.
    yield* hooks.register(
      HOOK,
      Effect.gen(function* () {
        const first = yield* run(true).pipe(Effect.forkIn(scope, { startImmediately: true }))
        yield* Fiber.await(first).pipe(Effect.timeoutOption(BOOT_WAIT))
        yield* InstanceState.get(loops)
      }),
    )

    return Service.of({ reconcile: () => run(true) })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    InstanceHooks.node,
    Session.node,
    SessionPrompt.node,
    TaskNotify.node,
    SpendGuard.node,
    BackgroundJobStore.node,
    Database.node,
    TaskIsolation.node,
  ],
})

export * as TaskRecovery from "./recovery"
