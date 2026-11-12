import { Cause, Clock, Context, Effect, Fiber, Layer, Option, Scope, Semaphore, Stream } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import type { EventV2 } from "@vectordevai/core/event"
import { TaskSize } from "@vectordevai/core/task-size"
import type { SubagentRecord } from "@/agent/subagent-kind"
import { BackgroundJob } from "@/background/job"
import { TaskPlace } from "./place"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { InstanceHooks } from "@/project/instance-hooks"
import { Question } from "@/question"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { TaskNotify } from "./notify"
import { TaskSignals } from "./signals"

/*
 * Waiting on you (D.4). A running subagent blocked on a permission request or a question is marked `waiting` on its
 * record, ends any task_manage wait that selected it, and its root conversation gets a quiet note, at most one per
 * helper every 10 minutes. With `sizing.subagents.ask_timeout` set, a request no one answers in time is declined,
 * never approved, by the instance that holds it, and the root gets a quiet note saying so.
 */

export interface Interface {
  /** Watches the current instance's asks until the scope closes. The instance boot hook runs it once per instance. */
  readonly watch: () => Effect.Effect<void, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@vector/TaskAttention") {}

/** The InstanceHooks name the watch starts under at every instance boot. */
export const HOOK = "task-attention"
/** A helper's root hears that it waits at most this often. */
export const NOTE_EVERY = 10 * 60 * 1000
const SUMMARY = 200

type Kind = "permission" | "question"
// A request a tracked child waits on, kept by request ID.
type Ask = {
  childID: SessionID
  attempt?: number
  kind: Kind
  since: number
  minutes?: number
  summary?: string
  timer?: Fiber.Fiber<void>
}

/** What the child asks, as one tag-neutralized line of at most 200 characters (Task.Waiting.summary). */
export function excerpt(text: string) {
  return [...TaskSize.neutralizeTags(text.replace(/\s+/g, " ").trim())].slice(0, SUMMARY).join("").trim() || undefined
}

/**
 * The quiet note a helper's root gets when the helper starts waiting, or when Vector declined its request. What the
 * helper asks stays out of it: that is the helper's own text, and the board shows it (Task.Info.waiting.summary).
 */
export function note(input: {
  taskID: string
  title: string
  kind: Kind
  state: "waiting" | "expired"
  minutes?: number
}) {
  const what = input.kind === "permission" ? "a permission request" : "a question"
  const who = `subagent ${input.taskID} ("${TaskSize.titled(input.title)}")`
  if (input.state === "expired")
    return `Vector note: no one answered ${what} from ${who} within ${input.minutes} min, so Vector declined it and the subagent carries on without it.`
  return [
    `Vector note: ${who} waits for the user to answer ${what} and is blocked until they answer in its session; tell them if they may not know.`,
    ...(input.minutes ? [`Unanswered, Vector declines it after ${input.minutes} min.`] : []),
  ].join(" ")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const jobs = yield* BackgroundJob.Service
    const permissions = yield* Permission.Service
    const questions = yield* Question.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const notify = yield* TaskNotify.Service
    const signals = yield* TaskSignals.Service
    const prompts = yield* SessionPrompt.Service
    const hooks = yield* InstanceHooks.Service
    const ops: TaskPromptOps = {
      cancel: (sessionID) => prompts.cancel(sessionID),
      resolvePromptParts: (template) => prompts.resolvePromptParts(template),
      prompt: (input) => prompts.prompt(input).pipe(Effect.catch(Effect.die)),
    }
    // When each helper's root last heard that it waits. The record's own `notedAt` goes when its wait ends, so this
    // keeps the 10-minute rule across a helper's separate waits. Session IDs are unique, so one map serves every instance.
    const noted = new Map<SessionID, number>()
    const remember = (childID: SessionID, at: number) => {
      noted.set(childID, at)
      // Only notes from the last 10 minutes still count.
      if (noted.size > 256) for (const [id, time] of noted) if (at - time >= NOTE_EVERY) noted.delete(id)
    }

    const find = (id: SessionID) => sessions.get(id).pipe(Effect.option, Effect.map(Option.getOrUndefined))
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

    const tell = Effect.fnUntraced(function* (
      child: Session.Info,
      record: SubagentRecord,
      ask: Ask,
      state: "waiting" | "expired",
    ) {
      const root = yield* rootOf(child)
      if (!root || root.time.archived !== undefined) return
      yield* notify.enqueue({
        parentID: root.id,
        note: {
          kind: "attention",
          taskID: child.id,
          attempt: ask.attempt,
          attention: ask.kind,
          state,
          text: note({ taskID: child.id, title: record.title, ...ask, state }),
          wake: false,
          quiet: true,
        },
        ops,
        agent: root.agent ?? "build",
      })
    })

    const watch: Interface["watch"] = Effect.fnUntraced(function* () {
      const scope = yield* Scope.Scope
      const directory = yield* InstanceState.directory
      const asks = new Map<string, Ask>()
      // Every change to `asks` and to the records' `waiting` runs under it: asks and replies arrive on separate streams.
      const lock = Semaphore.makeUnsafe(1)
      const pending = Effect.fnUntraced(function* (kind: Kind, requestID: string) {
        const items: ReadonlyArray<{ id: string }> =
          kind === "permission" ? yield* permissions.list() : yield* questions.list()
        return items.some((item) => item.id === requestID)
      })

      // The child's `waiting` moves to the next request it still waits on, or clears.
      const moveOn = (ask: Ask, requestID: string) =>
        SubagentLifecycle.modify(sessions, ask.childID, (current) => {
          if (current.waiting?.requestID !== requestID) return { value: undefined }
          const next = [...asks]
            .filter(([, item]) => item.childID === ask.childID && item.attempt === current.attempt)
            .sort(([, a], [, b]) => a.since - b.since)[0]
          const notedAt = current.waiting.notedAt
          return {
            patch: {
              waiting: next && {
                kind: next[1].kind,
                requestID: next[0],
                since: next[1].since,
                ...(next[1].minutes ? { expiresAt: next[1].since + next[1].minutes * 60_000 } : {}),
                ...(next[1].summary ? { summary: next[1].summary } : {}),
                ...(notedAt === undefined ? {} : { notedAt }),
              },
            },
            value: undefined,
          }
        })

      // The request ran out: only it is declined, the child's other requests keep waiting.
      const expire = Effect.fnUntraced(function* (requestID: string) {
        const ask = asks.get(requestID)
        if (!ask) return
        asks.delete(requestID)
        const declined =
          ask.kind === "permission"
            ? yield* permissions.expire(requestID, Permission.TIMED_OUT)
            : yield* questions.expire(requestID)
        yield* moveOn(ask, requestID)
        const child = declined ? yield* find(ask.childID) : undefined
        const record = child && SubagentLifecycle.read(child)
        if (child && record) yield* tell(child, record, ask, "expired")
      })

      const asked = Effect.fnUntraced(function* (input: {
        requestID: string
        sessionID: string
        kind: Kind
        summary?: string
      }) {
        if (asks.has(input.requestID)) return
        const child = yield* find(SessionID.make(input.sessionID))
        // Only a running subagent's own asks: never the root's, and never an internal session's.
        if (!child || child.internal || !child.parentID) return
        const record = SubagentLifecycle.read(child)
        if (
          record?.status !== "running" ||
          (yield* jobs.get(child.id).pipe(TaskPlace.within(child.parentID)))?.status !== "running"
        )
          return
        // Its answer may already have arrived on the other stream.
        if (!(yield* pending(input.kind, input.requestID))) return
        const now = yield* Clock.currentTimeMillis
        const minutes = (yield* config.get()).sizing?.subagents?.ask_timeout
        const ask: Ask = {
          childID: child.id,
          attempt: record.attempt,
          kind: input.kind,
          since: now,
          ...(minutes ? { minutes } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
        }
        asks.set(input.requestID, ask)
        const decided = yield* SubagentLifecycle.modify(sessions, child.id, (current) => {
          if (current.status !== "running" || current.attempt !== record.attempt) return { value: undefined }
          const held = current.waiting && asks.has(current.waiting.requestID) ? current.waiting : undefined
          const last = Math.max(current.waiting?.notedAt ?? -Infinity, noted.get(child.id) ?? -Infinity)
          const due = now - last >= NOTE_EVERY
          if (due) remember(child.id, now)
          const notedAt = due ? now : Number.isFinite(last) ? last : undefined
          const waiting = held ?? {
            kind: input.kind,
            requestID: input.requestID,
            since: now,
            ...(minutes ? { expiresAt: now + minutes * 60_000 } : {}),
            ...(input.summary ? { summary: input.summary } : {}),
          }
          return {
            patch: { waiting: notedAt === undefined ? waiting : { ...waiting, notedAt } },
            value: { starts: !held, due },
          }
        })
        if (!decided) {
          asks.delete(input.requestID)
          return
        }
        if (decided.starts) yield* signals.publish(child.id, "attention")
        if (decided.due) yield* tell(child, record, ask, "waiting")
        if (minutes)
          ask.timer = yield* Effect.sleep(minutes * 60_000).pipe(
            Effect.andThen(SubagentLifecycle.locked(lock)(expire(input.requestID))),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.void
                : Effect.logWarning("a helper's request could not be declined", { cause }),
            ),
            Effect.interruptible,
            Effect.forkIn(scope, { startImmediately: true }),
          )
      })

      // A reply or a withdrawal ends the wait; its timer is stopped once the lock is free again.
      const answered = (requestID: string) =>
        SubagentLifecycle.locked(lock)(
          Effect.gen(function* () {
            const ask = asks.get(requestID)
            if (!ask) return undefined
            asks.delete(requestID)
            yield* moveOn(ask, requestID)
            return ask.timer
          }),
        ).pipe(Effect.flatMap((timer) => (timer ? Fiber.interrupt(timer) : Effect.void)))

      // The event bus is global: only this instance's own asks are its to handle.
      const on = <D extends EventV2.Definition>(
        definition: D,
        handle: (data: EventV2.Data<D>) => Effect.Effect<unknown, unknown>,
      ) =>
        events.subscribe(definition).pipe(
          Stream.runForEach((event) =>
            event.location?.directory !== directory
              ? Effect.void
              : handle(event.data).pipe(
                  Effect.catchCause((cause) => Effect.logWarning("a helper's wait was not tracked", { cause })),
                ),
          ),
          Effect.interruptible,
          Effect.forkIn(scope, { startImmediately: true }),
        )
      yield* on(Permission.Event.Asked, (data) =>
        SubagentLifecycle.locked(lock)(
          asked({
            requestID: data.id,
            sessionID: data.sessionID,
            kind: "permission",
            summary: excerpt(`${data.permission} ${data.patterns.join(" ")}`),
          }),
        ),
      )
      yield* on(Question.Event.Asked, (data) =>
        SubagentLifecycle.locked(lock)(
          asked({
            requestID: data.id,
            sessionID: data.sessionID,
            kind: "question",
            summary: excerpt(data.questions.map((item) => item.question).join(" / ")),
          }),
        ),
      )
      yield* on(Permission.Event.Replied, (data) => answered(data.requestID))
      yield* on(Question.Event.Replied, (data) => answered(data.requestID))
      yield* on(Question.Event.Rejected, (data) => answered(data.requestID))
    })

    const watching = yield* InstanceState.make(() => watch())
    yield* hooks.register(HOOK, InstanceState.get(watching))

    return Service.of({ watch })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    InstanceHooks.node,
    Session.node,
    SessionPrompt.node,
    BackgroundJob.node,
    Permission.node,
    Question.node,
    Config.node,
    EventV2Bridge.node,
    TaskNotify.node,
    TaskSignals.node,
  ],
})

export * as TaskAttention from "./attention"
