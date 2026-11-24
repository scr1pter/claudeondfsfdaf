import { createHash, randomUUID } from "node:crypto"
import { Clock, Context, Deferred, Effect, Layer, Schema, Semaphore } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { TaskMailbox } from "@vectordevai/core/task-mailbox"
import { RunBudget } from "@vectordevai/schema/run-budget"
import { Task } from "@vectordevai/schema/task"
import { TaskBridge } from "@vectordevai/schema/task-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { isRecord } from "@/util/record"

export * as DesktopTasks from "./desktop"

export class Error extends Schema.TaggedErrorClass<Error>()("DesktopTasks.Error", {
  code: Schema.Literals(["not_found", "forbidden", "invalid", "finished", "rate_limited"]),
  message: Schema.String,
}) {}

const Pending = Schema.Struct({
  command: TaskBridge.Command,
  result: Schema.optional(Schema.Union([Task.InspectResult, Task.MessageResult, Task.StopResult])),
  error: Schema.optional(Schema.String),
})
const Stored = Schema.Struct({
  runtimeID: Schema.String,
  directory: Schema.String,
  leaseHash: Schema.String,
  expiresAt: Schema.Finite,
  tasks: Schema.Array(Task.Info),
  truncated: Schema.optional(Schema.Boolean),
  commands: Schema.Array(Pending),
})
type Stored = typeof Stored.Type
type Scope = { sessionID: SessionID; taskID: string }
const RUNTIME_ID = randomUUID()
const LEASE_MS = 75_000
const COMMAND_MS = 30_000
const active = (task: Task.Info) => ["queued", "running", "waiting_on_user"].includes(task.status)
export const owns = (id: string) => id.startsWith("workspace:") || id.startsWith("swarm:")
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export class Service extends Context.Service<
  Service,
  {
    register(
      input: { sessionID: SessionID } & typeof TaskBridge.RegisterInput.Type,
    ): Effect.Effect<typeof TaskBridge.RegisterResult.Type, Error>
    poll(
      input: { sessionID: SessionID } & typeof TaskBridge.PollInput.Type,
    ): Effect.Effect<typeof TaskBridge.PollResult.Type, Error>
    receipt(
      input: { sessionID: SessionID } & typeof TaskBridge.ReceiptInput.Type,
    ): Effect.Effect<typeof TaskBridge.ReceiptResult.Type, Error>
    list(input: { sessionID: SessionID; descendants?: boolean }): Effect.Effect<Task.ListResult, Error>
    get(input: Scope): Effect.Effect<Task.Info, Error>
    inspect(input: Scope): Effect.Effect<Task.InspectResult, Error>
    message(input: Scope & { text: string; delivery?: "steer" | "queue" }): Effect.Effect<Task.MessageResult, Error>
    stop(input: Scope & { reason?: string }): Effect.Effect<Task.StopResult, Error>
    wait(input: Scope & { timeout: number }): Effect.Effect<void, Error>
  }
>()("@vector/DesktopTasks") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const clock = yield* Clock.Clock
    const scope = yield* Effect.scope
    const lock = Semaphore.makeUnsafe(1)
    const signals = new Map<string, Deferred.Deferred<void>>()
    const signal = (id: string) => {
      const found = signals.get(id)
      if (found) return found
      const next = Deferred.makeUnsafe<void>()
      signals.set(id, next)
      return next
    }
    const changed = Effect.fn("DesktopTasks.changed")(function* (id: SessionID) {
      const previous = signals.get(id)
      signals.set(id, Deferred.makeUnsafe<void>())
      if (previous) yield* Deferred.succeed(previous, undefined)
      yield* sessions.touch(id)
    })
    const requireSession = Effect.fn("DesktopTasks.requireSession")(function* (id: SessionID) {
      const session = yield* sessions
        .get(id)
        .pipe(Effect.mapError(() => new Error({ code: "not_found", message: "The parent session was not found." })))
      if (session.directory !== (yield* InstanceState.directory))
        return yield* new Error({ code: "forbidden", message: "Desktop tasks belong to another repository." })
      return session
    })
    const write = (id: SessionID, record: Stored) => storage.write(["task-bridge", id], record).pipe(Effect.orDie)
    const read = Effect.fn("DesktopTasks.read")(function* (id: SessionID) {
      const raw = yield* storage.read<unknown>(["task-bridge", id]).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (raw === undefined) return undefined
      const parsed = Schema.decodeUnknownOption(Stored)(knownCostKinds(raw))
      if (parsed._tag === "None")
        return yield* new Error({
          code: "invalid",
          message: "The desktop task record is damaged; reconnect the desktop to register it again.",
        })
      const record = parsed.value
      if (record.directory !== (yield* InstanceState.directory))
        return yield* new Error({ code: "forbidden", message: "Desktop tasks belong to another repository." })
      if (record.runtimeID === RUNTIME_ID && record.expiresAt > clock.currentTimeMillisUnsafe()) return record
      const tasks = record.tasks.map(
        (task): Task.Info => ({
          ...task,
          connection: "disconnected",
          controls: { inspect: true, message: false, stop: false },
        }),
      )
      const next = { ...record, expiresAt: 0, tasks }
      if (JSON.stringify(tasks) !== JSON.stringify(record.tasks)) {
        yield* write(id, next)
        yield* changed(id)
      }
      return next
    })
    const deadlines = new Map<SessionID, { expiresAt: number }>()
    const watchLease = Effect.fn("DesktopTasks.watchLease")(function* (id: SessionID, expiresAt: number) {
      const existing = deadlines.get(id)
      if (existing) {
        existing.expiresAt = expiresAt
        return
      }
      const deadline = { expiresAt }
      deadlines.set(id, deadline)
      // A single scoped timer wakes observers when the desktop disappears. Renewal
      // moves its next deadline; no request or periodic status poll is needed.
      yield* Effect.gen(function* () {
        while (deadlines.get(id) === deadline) {
          yield* Effect.sleep(Math.max(0, deadline.expiresAt - clock.currentTimeMillisUnsafe()))
          const expired = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const record = yield* read(id)
              if (!record || record.expiresAt <= clock.currentTimeMillisUnsafe()) {
                if (deadlines.get(id) === deadline) deadlines.delete(id)
                return true
              }
              deadline.expiresAt = record.expiresAt
              return false
            }),
          )
          if (expired) return
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (deadlines.get(id) === deadline) deadlines.delete(id)
          }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    })
    const requireLease = Effect.fn("DesktopTasks.requireLease")(function* (id: SessionID, lease: string) {
      yield* requireSession(id)
      const record = yield* read(id)
      if (
        !record ||
        record.runtimeID !== RUNTIME_ID ||
        record.expiresAt <= clock.currentTimeMillisUnsafe() ||
        record.leaseHash !== hash(lease)
      )
        return yield* new Error({
          code: "forbidden",
          message: "This desktop task lease is no longer owned by this connection.",
        })
      return record
    })
    const family = Effect.fn("DesktopTasks.family")(function* (id: SessionID, descendants = true) {
      yield* requireSession(id)
      const found = [id]
      for (let index = 0; descendants && index < found.length && found.length <= 200; index++) {
        const children = yield* sessions.children(found[index]!)
        children
          .filter((child) => !child.internal && !found.includes(child.id))
          .forEach((child) => found.push(child.id))
      }
      return { ids: found.slice(0, 200), truncated: found.length > 200 }
    })
    const locate = Effect.fn("DesktopTasks.locate")(function* (input: Scope) {
      const related = yield* family(input.sessionID)
      for (const id of related.ids) {
        const record = yield* lock.withPermits(1)(read(id))
        const task = record?.tasks.find((task) => task.id === input.taskID)
        if (record && task) return { owner: id, record, task }
      }
      return yield* new Error({
        code: "not_found",
        message: "The desktop task does not belong to this session's descendants.",
      })
    })
    const register = Effect.fn("DesktopTasks.register")(
      (input: { sessionID: SessionID } & typeof TaskBridge.RegisterInput.Type) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* requireSession(input.sessionID)
            if (JSON.stringify(input.tasks).length > 512_000 || input.tasks.length > 200)
              return yield* new Error({
                code: "invalid",
                message: "Desktop task observations exceed the bounded snapshot limit.",
              })
            if (
              input.tasks.some(
                (task) => !owns(task.id) || task.parentSessionID !== input.sessionID || task.id.length > 240,
              )
            )
              return yield* new Error({
                code: "forbidden",
                message: "Desktop observations must use workspace or swarm identities within their parent session.",
              })
            if (new Set(input.tasks.map((task) => task.id)).size !== input.tasks.length)
              return yield* new Error({ code: "invalid", message: "Desktop task identities must be unique." })
            const previous = input.lease ? yield* requireLease(input.sessionID, input.lease) : undefined
            const lease = input.lease ?? `${randomUUID()}${randomUUID()}`
            const expiresAt = clock.currentTimeMillisUnsafe() + LEASE_MS
            const tasks = input.tasks.map((task) => ({
              ...task,
              title: task.title.slice(0, 240),
              currentStep: task.currentStep?.slice(0, 500),
              reason: task.reason?.slice(0, 1000),
              ownedPaths: task.ownedPaths.slice(0, 64).map((path) => path.slice(0, 500)),
              dependsOn: task.dependsOn.slice(0, 64),
            }))
            const record = {
              runtimeID: RUNTIME_ID,
              directory: yield* InstanceState.directory,
              leaseHash: hash(lease),
              expiresAt,
              tasks,
              truncated: input.truncated ?? false,
              commands:
                previous?.commands.filter(
                  (item) => item.command.createdAt > clock.currentTimeMillisUnsafe() - 60_000,
                ) ?? [],
            }
            yield* write(input.sessionID, record)
            yield* watchLease(input.sessionID, expiresAt)
            if (
              !previous ||
              previous.truncated !== record.truncated ||
              JSON.stringify(previous.tasks) !== JSON.stringify(tasks)
            )
              yield* changed(input.sessionID)
            return { lease, expiresAt }
          }),
        ),
    )
    const poll = Effect.fn("DesktopTasks.poll")(function* (
      input: { sessionID: SessionID } & typeof TaskBridge.PollInput.Type,
    ) {
      const waiting = signal(input.sessionID)
      const snapshot = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* requireLease(input.sessionID, input.lease)
          const next = { ...record, runtimeID: RUNTIME_ID, expiresAt: clock.currentTimeMillisUnsafe() + LEASE_MS }
          yield* write(input.sessionID, next)
          yield* watchLease(input.sessionID, next.expiresAt)
          return next
        }),
      )
      const pending = (record: Stored) =>
        record.commands
          .filter((item) => !item.result && !item.error && item.command.expiresAt > clock.currentTimeMillisUnsafe())
          .map((item) => item.command)
      if (pending(snapshot).length || input.timeout === 0)
        return { commands: pending(snapshot), expiresAt: snapshot.expiresAt }
      yield* Deferred.await(waiting).pipe(Effect.timeoutOption(input.timeout ?? 30_000))
      const latest = yield* lock.withPermits(1)(requireLease(input.sessionID, input.lease))
      return { commands: pending(latest), expiresAt: latest.expiresAt }
    })
    const receipt = Effect.fn("DesktopTasks.receipt")(
      (input: { sessionID: SessionID } & typeof TaskBridge.ReceiptInput.Type) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const record = yield* requireLease(input.sessionID, input.lease)
            const item = record.commands.find((item) => item.command.id === input.commandID)
            if (!item || item.command.expiresAt <= clock.currentTimeMillisUnsafe())
              return yield* new Error({
                code: "finished",
                message: "The desktop command has expired; no receipt was accepted.",
              })
            if (item.result || item.error) {
              if (JSON.stringify(item.result) !== JSON.stringify(input.result) || item.error !== input.error)
                return yield* new Error({
                  code: "invalid",
                  message: "This desktop command already has a different receipt.",
                })
              return { accepted: true }
            }
            if (Boolean(input.result) === Boolean(input.error))
              return yield* new Error({ code: "invalid", message: "Return one command result or one error." })
            const resultSchema =
              item.command.action === "inspect"
                ? Task.InspectResult
                : item.command.action === "message"
                  ? Task.MessageResult
                  : Task.StopResult
            if (input.result && Schema.decodeUnknownOption(resultSchema)(input.result)._tag === "None")
              return yield* new Error({ code: "invalid", message: "The desktop receipt does not match its command." })
            if (input.result && JSON.stringify(input.result).length > 65_536)
              return yield* new Error({ code: "invalid", message: "Desktop command output exceeds its bounded limit." })
            if (input.result) {
              const result = input.result
              const wrong =
                "task" in result
                  ? result.task.id !== item.command.taskID || result.task.parentSessionID !== input.sessionID
                  : "taskID" in result
                    ? result.taskID !== item.command.taskID
                    : result.tasks.some(
                        (task) =>
                          !record.tasks.some((owned) => owned.id === task.id) ||
                          task.parentSessionID !== input.sessionID,
                      )
              if (wrong)
                return yield* new Error({
                  code: "forbidden",
                  message: "The desktop receipt references a task outside this command's scope.",
                })
            }
            const next = {
              ...record,
              commands: record.commands.map((entry) =>
                entry === item ? { ...entry, result: input.result, error: input.error } : entry,
              ),
            }
            yield* write(input.sessionID, next)
            yield* changed(input.sessionID)
            return { accepted: true }
          }),
        ),
    )
    const request = Effect.fn("DesktopTasks.request")(function* (
      input: Scope & {
        action: TaskBridge.Command["action"]
        text?: string
        delivery?: "steer" | "queue"
        reason?: string
      },
    ) {
      const target = yield* locate(input)
      const command: TaskBridge.Command = {
        id: randomUUID(),
        taskID: target.task.id,
        sender: input.sessionID,
        action: input.action,
        text: input.text,
        delivery: input.delivery,
        reason: input.reason,
        createdAt: clock.currentTimeMillisUnsafe(),
        expiresAt: clock.currentTimeMillisUnsafe() + COMMAND_MS,
      }
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const record = yield* read(target.owner)
          const task = record?.tasks.find((task) => task.id === input.taskID)
          if (!record || record.expiresAt <= clock.currentTimeMillisUnsafe() || !task?.controls[input.action])
            return yield* new Error({
              code: "finished",
              message: "The desktop task cannot accept this control. Reconnect or open its saved result.",
            })
          const commands = record.commands.filter(
            (item) => item.command.createdAt > clock.currentTimeMillisUnsafe() - 60_000,
          )
          if (commands.length >= 100)
            return yield* new Error({
              code: "rate_limited",
              message: "The desktop command queue is full. Wait for outstanding controls to finish.",
            })
          if (input.action === "message") {
            const error = TaskMailbox.admissionError({
              text: input.text ?? "",
              sentAt: commands
                .filter((item) => item.command.action === "message" && item.command.sender === input.sessionID)
                .map((item) => item.command.createdAt),
              pending: commands.filter((item) => !item.result && !item.error).length,
              now: clock.currentTimeMillisUnsafe(),
            })
            if (error) return yield* new Error({ code: "rate_limited", message: error })
          }
          yield* write(target.owner, { ...record, commands: [...commands, { command }] })
          yield* changed(target.owner)
        }),
      )
      while (clock.currentTimeMillisUnsafe() < command.expiresAt) {
        const waiting = signal(target.owner)
        const record = yield* lock.withPermits(1)(read(target.owner))
        const item = record?.commands.find((item) => item.command.id === command.id)
        if (item?.error) return yield* new Error({ code: "finished", message: item.error })
        if (item?.result) return item.result
        if (
          !record ||
          record.leaseHash !== target.record.leaseHash ||
          record.expiresAt <= clock.currentTimeMillisUnsafe()
        )
          break
        yield* Deferred.await(waiting).pipe(
          Effect.timeoutOption(Math.max(0, command.expiresAt - clock.currentTimeMillisUnsafe())),
        )
      }
      return yield* new Error({
        code: "finished",
        message:
          "The desktop did not confirm this command before it expired. Inspect its current state before retrying.",
      })
    })
    return Service.of({
      register,
      poll,
      receipt,
      list: Effect.fn("DesktopTasks.list")(function* (input) {
        const related = yield* family(input.sessionID, input.descendants ?? false)
        const records = yield* Effect.forEach(related.ids, (id) => lock.withPermits(1)(read(id)))
        return {
          tasks: records.flatMap((record) => record?.tasks ?? []),
          truncated: related.truncated || records.some((record) => record?.truncated === true),
        }
      }),
      get: (input) => locate(input).pipe(Effect.map((target) => target.task)),
      inspect: Effect.fn("DesktopTasks.inspect")(function* (input) {
        const target = yield* locate(input)
        if (target.record.expiresAt <= clock.currentTimeMillisUnsafe())
          return {
            task: target.task,
            steps: [],
            output: "Desktop disconnected. Open the task in the desktop to inspect its retained output.",
            truncated: true,
          }
        return yield* request({ ...input, action: "inspect" }).pipe(
          Effect.map((result) => result as Task.InspectResult),
        )
      }),
      message: (input) =>
        request({ ...input, action: "message" }).pipe(Effect.map((result) => result as Task.MessageResult)),
      stop: (input) => request({ ...input, action: "stop" }).pipe(Effect.map((result) => result as Task.StopResult)),
      wait: Effect.fn("DesktopTasks.wait")(function* (input) {
        const deadline = clock.currentTimeMillisUnsafe() + input.timeout
        while (clock.currentTimeMillisUnsafe() < deadline) {
          const target = yield* locate(input)
          const waiting = signal(target.owner)
          if (!active((yield* locate(input)).task)) return
          yield* Deferred.await(waiting).pipe(
            Effect.timeoutOption(
              Math.max(
                0,
                (target.record.expiresAt > clock.currentTimeMillisUnsafe()
                  ? Math.min(deadline, target.record.expiresAt)
                  : deadline) - clock.currentTimeMillisUnsafe(),
              ),
            ),
          )
        }
      }),
    })
  }),
)

// A stored record a newer engine wrote may name a cost kind this one does not know (F6). Desktop and engine ship
// together, so only a downgrade, or a stale record left behind, meets one; it reads as "unknown", as a desktop's own
// report would, instead of marking the whole record damaged. Only string values are mapped: any other malformed
// field still fails the decode.
function knownCostKinds(raw: unknown) {
  if (!isRecord(raw) || !Array.isArray(raw.tasks)) return raw
  return {
    ...raw,
    tasks: raw.tasks.map((task) => {
      if (!isRecord(task)) return task
      const scopes = task.budgetScopes
      return {
        ...knownCostKind(task),
        ...(Array.isArray(scopes)
          ? { budgetScopes: scopes.map((scope) => (isRecord(scope) ? knownCostKind(scope) : scope)) }
          : {}),
      }
    }),
  }
}

const knownKind = Schema.is(RunBudget.CostKind)

function knownCostKind(value: Record<string, unknown>) {
  return typeof value.costKind === "string" && !knownKind(value.costKind) ? { ...value, costKind: "unknown" } : value
}

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node, Storage.node] })
