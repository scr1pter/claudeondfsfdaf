import { afterEach, describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Database } from "@vectordevai/core/database/database"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The lifecycle helpers later work shares: the notification claim, batch entry patches, orphaned parts, and the rules
// for when a helper waits for the user.

afterEach(disposeAllInstances)

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, Database.node, SpendGuard.node])))

const model = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("fixture") }

// A parent with the assistant message whose task call launched its children.
const parent = Effect.fn("SubagentLifecycleTest.parent")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Parent" })
  const launch = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: MessageID.ascending(),
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
    time: { created: Date.now() },
  } satisfies SessionV1.Assistant)
  return { id: chat.id, launch: launch.id }
})

const child = Effect.fn("SubagentLifecycleTest.child")(function* (
  parentID: SessionID,
  launch: MessageID,
  extra: Record<string, unknown> = {},
) {
  const sessions = yield* Session.Service
  return (yield* sessions.create({
    parentID,
    metadata: {
      subagent: {
        kind: "subagent",
        custom: false,
        agent: "general",
        title: "Survey",
        parentSessionID: parentID,
        parentMessageID: launch,
        model,
        background: true,
        status: "completed",
        startedAt: Date.now(),
        runtimeID: "previous-process",
        attempt: 1,
        ...extra,
      },
    },
  })).id
})

// Stores the parent's task tool part in the given state.
const toolPart = Effect.fn("SubagentLifecycleTest.toolPart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  state: SessionV1.ToolPart["state"],
) {
  const sessions = yield* Session.Service
  const callID = `call_${PartID.ascending()}`
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool",
    callID,
    tool: "task",
    state,
  })
  return callID
})

const stored = (messageID: MessageID, callID: string) =>
  MessageV2.parts(messageID).pipe(
    Effect.map(
      (parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === callID)!,
    ),
  )

const entries = () => [
  { index: 0, title: "Map auth", status: "running", sessionId: "ses_a" },
  { index: 1, title: "Map routes", status: "completed", sessionId: "ses_b" },
  { index: 2, title: "Map jobs", status: "pending" },
]

describe("SubagentLifecycle.claimNotification", () => {
  it.instance("two concurrent claims win once, and a claimed note is not claimed again", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { id, launch } = yield* parent()
      const a = yield* child(id, launch, { notification: { text: "Report", state: "completed", launchID: launch } })
      const first = MessageID.ascending()
      const second = MessageID.ascending()

      const won = yield* Effect.all(
        [
          SubagentLifecycle.claimNotification(sessions, database, a, 1, first),
          SubagentLifecycle.claimNotification(sessions, database, a, 1, second),
        ],
        { concurrency: "unbounded" },
      )
      expect(won.filter(Boolean)).toHaveLength(1)
      const claimed = SubagentLifecycle.read(yield* sessions.get(a))?.notification?.messageID
      expect(claimed).toBe(won[0] ? first : second)

      expect(yield* SubagentLifecycle.claimNotification(sessions, database, a, 1, MessageID.ascending())).toBe(false)
      expect(SubagentLifecycle.read(yield* sessions.get(a))?.notification?.messageID).toBe(claimed)
    }),
  )

  it.instance("a claim for another attempt, or with no note, loses", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { id, launch } = yield* parent()
      const a = yield* child(id, launch, {
        attempt: 2,
        notification: { text: "Report", state: "completed", launchID: launch },
      })
      const b = yield* child(id, launch)
      expect(yield* SubagentLifecycle.claimNotification(sessions, database, a, 1, MessageID.ascending())).toBe(false)
      expect(SubagentLifecycle.read(yield* sessions.get(a))?.notification?.messageID).toBeUndefined()
      expect(yield* SubagentLifecycle.claimNotification(sessions, database, b, 1, MessageID.ascending())).toBe(false)
      expect(yield* SubagentLifecycle.claimNotification(sessions, database, a, 2, MessageID.ascending())).toBe(true)
    }),
  )

  it.instance("a claim another engine wrote after this one read the note unclaimed wins", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { id, launch } = yield* parent()
      const a = yield* child(id, launch, { notification: { text: "Report", state: "completed", launchID: launch } })
      // This engine read the record before the other engine's claim landed in the shared vector.db.
      const before = yield* sessions.get(a)
      const theirs = MessageID.ascending()
      const path = "$.subagent.notification.messageID"
      yield* database.db.run(sql`UPDATE session SET metadata = json_set(metadata, ${path}, ${theirs}) WHERE id = ${a}`)
      const stale = { ...sessions, get: () => Effect.succeed(before) } as Session.Interface

      expect(yield* SubagentLifecycle.claimNotification(stale, database, a, 1, MessageID.ascending())).toBe(false)
      expect(SubagentLifecycle.read(yield* sessions.get(a))?.notification?.messageID).toBe(theirs)
    }),
  )

  it.instance("two prompts recovering at once deliver a note once", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { id, launch } = yield* parent()
      yield* child(id, launch, { notification: { text: "A compact finding", state: "completed", launchID: launch } })

      const recovered = yield* Effect.all(
        [
          SubagentLifecycle.recover(sessions, database, id, MessageID.ascending()),
          SubagentLifecycle.recover(sessions, database, id, MessageID.ascending()),
        ],
        { concurrency: "unbounded" },
      )
      expect(recovered.flat()).toHaveLength(1)
      expect(recovered.flat()[0]?.text).toBe("A compact finding")
    }),
  )

  it.instance("a claim whose message was never written is recovered once its grace has passed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { id, launch } = yield* parent()
      const old = Date.now() - SubagentLifecycle.CLAIM_GRACE - 1_000
      const note = { text: "Report", state: "completed" as const, launchID: launch }
      // The engine claimed it and stopped before it wrote the message.
      const lost = yield* child(id, launch, { notification: { ...note, messageID: MessageID.ascending(), claimedAt: old } })
      // An older version's claim, without a date.
      const legacy = yield* child(id, launch, { notification: { ...note, messageID: MessageID.ascending() } })
      // Still its claimer's to write.
      const writing = MessageID.ascending()
      const fresh = yield* child(id, launch, { notification: { ...note, messageID: writing, claimedAt: Date.now() } })
      // Delivered: its message exists.
      const delivered = yield* child(id, launch, { notification: { ...note, messageID: launch, claimedAt: old } })

      const human = [MessageID.ascending(), MessageID.ascending()]
      const recovered = yield* Effect.all(
        human.map((messageID) => SubagentLifecycle.recover(sessions, database, id, messageID)),
        { concurrency: "unbounded" },
      )
      expect(
        recovered
          .flat()
          .map((part) => part.metadata.taskNotification.taskID)
          .toSorted(),
      ).toEqual([lost, legacy].toSorted())
      for (const taskID of [lost, legacy]) {
        const claim = SubagentLifecycle.read(yield* sessions.get(taskID))?.notification
        expect(human).toContain(claim?.messageID as MessageID)
        expect(claim?.claimedAt).toBeGreaterThan(old)
      }
      expect(SubagentLifecycle.read(yield* sessions.get(fresh))?.notification?.messageID).toBe(writing)
      expect(SubagentLifecycle.read(yield* sessions.get(delivered))?.notification?.messageID).toBe(launch)
    }),
  )

  it.instance("a claim is released only when its message was never written", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { id, launch } = yield* parent()
      const note = { text: "Report", state: "completed" as const, launchID: launch }
      const failed = MessageID.ascending()
      const unwritten = yield* child(id, launch, { notification: { ...note, messageID: failed, claimedAt: 1 } })
      const other = yield* child(id, launch, {
        notification: { ...note, messageID: MessageID.ascending(), claimedAt: 1 },
      })
      const written = yield* child(id, launch, { notification: { ...note, messageID: launch, claimedAt: 1 } })

      yield* SubagentLifecycle.releaseNotifications(sessions, database, id, failed, [unwritten, other])
      yield* SubagentLifecycle.releaseNotifications(sessions, database, id, launch, [written])
      expect(SubagentLifecycle.read(yield* sessions.get(unwritten))?.notification).toEqual(note)
      expect(SubagentLifecycle.read(yield* sessions.get(other))?.notification?.messageID).toBeDefined()
      expect(SubagentLifecycle.read(yield* sessions.get(written))?.notification?.messageID).toBe(launch)
    }),
  )
})

describe("SubagentLifecycle.patchEntry", () => {
  it.instance("patches tasks[index] of a batch part and recomputes the batch status", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { id, launch } = yield* parent()
      const tasks = entries().slice(0, 2)
      const callID = yield* toolPart(id, launch, {
        status: "completed",
        input: {},
        output: "",
        title: "2 subagent tasks",
        metadata: { taskBatch: 1, status: "running", tasks },
        time: { start: 1, end: 2 },
      })

      expect(
        yield* SubagentLifecycle.patchEntry({
          sessions,
          messageID: launch,
          callID,
          index: 0,
          patch: { status: "completed", completedAt: 5, error: undefined },
        }),
      ).toBe(true)
      const part = yield* stored(launch, callID)
      expect(part.state.status).toBe("completed")
      const metadata = part.state.status === "completed" ? part.state.metadata : {}
      expect(metadata.tasks).toEqual([{ ...tasks[0], status: "completed", completedAt: 5 }, tasks[1]])
      expect(metadata.status).toBe("completed")
    }),
  )

  it.instance("leaves a part alone when it is not a batch or has no such entry", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { id, launch } = yield* parent()
      const single = yield* toolPart(id, launch, {
        status: "completed",
        input: {},
        output: "",
        title: "Survey",
        metadata: { status: "running" },
        time: { start: 1, end: 2 },
      })
      const batch = yield* toolPart(id, launch, {
        status: "completed",
        input: {},
        output: "",
        title: "2 subagent tasks",
        metadata: { taskBatch: 1, status: "running", tasks: entries().slice(0, 2) },
        time: { start: 1, end: 2 },
      })
      const patch = { status: "cancelled" }
      expect(
        yield* SubagentLifecycle.patchEntry({ sessions, messageID: launch, callID: single, index: 0, patch }),
      ).toBe(false)
      expect(yield* SubagentLifecycle.patchEntry({ sessions, messageID: launch, callID: batch, index: 5, patch })).toBe(
        false,
      )
      expect(
        yield* SubagentLifecycle.patchEntry({ sessions, messageID: launch, callID: "call_missing", index: 0, patch }),
      ).toBe(false)
      const part = yield* stored(launch, batch)
      expect(part.state.status === "completed" ? part.state.metadata.tasks : undefined).toEqual(entries().slice(0, 2))
    }),
  )
})

describe("a returned batch's own writes", () => {
  it.instance("merge only their entry, so a sibling's patched entry survives", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { id, launch } = yield* parent()
      const tasks = [
        { index: 0, title: "Map auth", status: "running", sessionId: "ses_a" },
        { index: 1, title: "Map routes", status: "running", sessionId: "ses_b" },
      ]
      const callID = yield* toolPart(id, launch, {
        status: "completed",
        input: {},
        output: "",
        title: "2 subagent tasks",
        metadata: { taskBatch: 1, status: "running", tasks },
        time: { start: 1, end: 2 },
      })
      // A stop settles entry 0 while entry 1 still runs.
      yield* SubagentLifecycle.patchEntry({ sessions, messageID: launch, callID, index: 0, patch: { status: "cancelled" } })
      // Entry 1 settles; the batch's memory still says entry 0 is running.
      yield* SubagentLifecycle.patchPart({
        sessions,
        messageID: launch,
        callID,
        patch: (metadata) => SubagentLifecycle.batchEntry(metadata, 1, { ...tasks[1], status: "completed" }) ?? {},
      })
      const part = yield* stored(launch, callID)
      const metadata = part.state.status === "completed" ? part.state.metadata : {}
      expect(metadata.tasks).toEqual([
        { ...tasks[0], status: "cancelled" },
        { ...tasks[1], status: "completed" },
      ])
      expect(metadata.status).toBe("cancelled")
    }),
  )
})

describe("SubagentLifecycle.settleOrphanPart", () => {
  it.instance("turns a running part into an error marked interrupted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { id, launch } = yield* parent()
      const callID = yield* toolPart(id, launch, {
        status: "running",
        input: { description: "Survey" },
        title: "Survey",
        metadata: { sessionId: "ses_a", status: "running" },
        time: { start: 10 },
      })

      expect(yield* SubagentLifecycle.settleOrphanPart({ sessions, messageID: launch, callID })).toBe(true)
      const part = yield* stored(launch, callID)
      expect(part.state.status).toBe("error")
      if (part.state.status !== "error") return
      expect(part.state.error).toBe(SubagentLifecycle.INTERRUPTED_ERROR)
      expect(part.state.input).toEqual({ description: "Survey" })
      expect(part.state.time.start).toBe(10)
      expect(part.state.time.end).toBeGreaterThanOrEqual(10)
      expect(part.state.metadata).toMatchObject({ sessionId: "ses_a", status: "cancelled", interrupted: true })
    }),
  )

  it.instance("a running batch part cancels every unsettled entry and keeps the settled ones", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { id, launch } = yield* parent()
      const callID = yield* toolPart(id, launch, {
        status: "running",
        input: {},
        title: "3 subagent tasks",
        metadata: { taskBatch: 1, status: "running", tasks: entries() },
        time: { start: 10 },
      })

      expect(yield* SubagentLifecycle.settleOrphanPart({ sessions, messageID: launch, callID, index: 0 })).toBe(true)
      const part = yield* stored(launch, callID)
      if (part.state.status !== "error") throw new Error(`expected an error part, saw ${part.state.status}`)
      const metadata = part.state.metadata ?? {}
      expect(metadata.interrupted).toBe(true)
      expect(metadata.status).toBe("cancelled")
      expect(metadata.tasks).toMatchObject([
        { index: 0, status: "cancelled", interrupted: true },
        { index: 1, status: "completed" },
        { index: 2, status: "cancelled", interrupted: true },
      ])
      expect(metadata.tasks[1].interrupted).toBeUndefined()
    }),
  )

  it.instance("a settled background launch moves only this child's entry, or its own status, to cancelled", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { id, launch } = yield* parent()
      const settled = (metadata: Record<string, unknown>) => ({
        status: "completed" as const,
        input: {},
        output: "",
        title: "Survey",
        metadata,
        time: { start: 1, end: 2 },
      })
      const batch = yield* toolPart(
        id,
        launch,
        settled({ taskBatch: 1, status: "running", tasks: entries().slice(0, 2) }),
      )
      const single = yield* toolPart(id, launch, settled({ sessionId: "ses_c", status: "running", background: true }))
      const done = yield* toolPart(id, launch, settled({ sessionId: "ses_d", status: "completed", background: true }))

      expect(yield* SubagentLifecycle.settleOrphanPart({ sessions, messageID: launch, callID: batch, index: 0 })).toBe(
        true,
      )
      // An entry that already settled is not rewritten.
      expect(yield* SubagentLifecycle.settleOrphanPart({ sessions, messageID: launch, callID: batch, index: 1 })).toBe(
        false,
      )
      expect(yield* SubagentLifecycle.settleOrphanPart({ sessions, messageID: launch, callID: single })).toBe(true)
      expect(yield* SubagentLifecycle.settleOrphanPart({ sessions, messageID: launch, callID: done })).toBe(false)

      const batchPart = yield* stored(launch, batch)
      expect(batchPart.state.status).toBe("completed")
      if (batchPart.state.status !== "completed") return
      expect(batchPart.state.metadata.status).toBe("cancelled")
      expect(batchPart.state.metadata.tasks).toMatchObject([
        { index: 0, status: "cancelled", interrupted: true },
        { index: 1, status: "completed" },
      ])
      const singlePart = yield* stored(launch, single)
      expect(singlePart.state.status === "completed" ? singlePart.state.metadata : undefined).toMatchObject({
        status: "cancelled",
        interrupted: true,
        background: true,
      })
      const donePart = yield* stored(launch, done)
      expect(donePart.state.status === "completed" ? donePart.state.metadata.status : undefined).toBe("completed")
    }),
  )
})

describe("SubagentLifecycle.finish", () => {
  it.instance("settles the record of the attempt it names and leaves another attempt alone", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const { id, launch } = yield* parent()
      const a = yield* child(id, launch, { status: "running", attempt: 2 })

      expect(yield* SubagentLifecycle.finish(sessions, guard, a, 1, { status: "completed" })).toBeUndefined()
      expect(SubagentLifecycle.read(yield* sessions.get(a))?.status).toBe("running")

      const done = yield* SubagentLifecycle.finish(sessions, guard, a, 2, { status: "error", error: "Boom" })
      expect(done?.settled).toMatchObject({ status: "error", error: "Boom" })
      expect(SubagentLifecycle.read(yield* sessions.get(a))).toMatchObject({ status: "error", error: "Boom" })
    }),
  )
})

describe("SubagentLifecycle rules", () => {
  const record = { status: "cancelled" as const }

  test("needsHuman holds for an interruption not resumed since and for a stop by the user", () => {
    expect(SubagentLifecycle.needsHuman({ ...record, interruption: { at: 1, cause: "shutdown" } })).toBe(true)
    expect(SubagentLifecycle.needsHuman({ interruption: { at: 1, cause: "crash", resumedAt: 2 } })).toBe(false)
    expect(SubagentLifecycle.needsHuman({ stop: { by: "user", at: 3 } })).toBe(true)
    expect(SubagentLifecycle.needsHuman({ stop: { by: "agent", at: 3 } })).toBe(false)
    expect(SubagentLifecycle.needsHuman({ stop: { by: "system", at: 3 } })).toBe(false)
    expect(
      SubagentLifecycle.needsHuman({
        interruption: { at: 1, cause: "crash", resumedAt: 2 },
        stop: { by: "user", at: 3 },
      }),
    ).toBe(true)
    expect(SubagentLifecycle.needsHuman({})).toBe(false)
  })

  test("open holds for queued and running records only", () => {
    expect(SubagentLifecycle.open({ status: "queued" })).toBe(true)
    expect(SubagentLifecycle.open({ status: "running" })).toBe(true)
    for (const status of ["completed", "error", "cancelled"] as const)
      expect(SubagentLifecycle.open({ status })).toBe(false)
    expect(SubagentLifecycle.open(undefined)).toBe(false)
  })

  test("batchStatus: running while any entry runs, then error, then cancelled", () => {
    expect(SubagentLifecycle.batchStatus([{ status: "pending" }, { status: "error" }])).toBe("running")
    expect(SubagentLifecycle.batchStatus([{ status: "cancelled" }, { status: "error" }])).toBe("error")
    expect(SubagentLifecycle.batchStatus([{ status: "cancelled" }, { status: "completed" }])).toBe("cancelled")
    expect(SubagentLifecycle.batchStatus([{ status: "completed" }])).toBe("completed")
  })

  test("the resume briefs carry the resume marker", () => {
    expect(SubagentLifecycle.RESUME_BRIEF.startsWith("[vector:resume] Vector stopped while you were working")).toBe(
      true,
    )
    expect(SubagentLifecycle.RESUME_STOPPED_BRIEF.startsWith("[vector:resume] The user stopped you")).toBe(true)
  })

  test("settleRun keeps a finished run's text, cancels a stopped run, and fails a failed one with its text", async () => {
    const run = (error?: SessionV1.Assistant["error"]) =>
      ({
        info: { role: "assistant", ...(error ? { error } : {}) },
        parts: [
          { type: "text", text: "Found it" },
          { type: "text", text: "hidden", synthetic: true },
        ],
      }) as unknown as SessionV1.WithParts
    expect(await Effect.runPromise(SubagentLifecycle.settleRun(run()))).toBe("Found it")
    const stopped = await Effect.runPromiseExit(
      SubagentLifecycle.settleRun(run({ name: "MessageAbortedError", data: { message: "stopped" } })),
    )
    expect(Exit.isFailure(stopped) && Cause.hasInterrupts(stopped.cause)).toBe(true)
    const failed = await Effect.runPromiseExit(
      SubagentLifecycle.settleRun(run({ name: "APIError", data: { message: "overloaded", isRetryable: false } })),
    )
    expect(Exit.isFailure(failed)).toBe(true)
    if (Exit.isFailure(failed))
      expect(Cause.squash(failed.cause)).toMatchObject({ message: "overloaded", output: "Found it" })
  })
})
