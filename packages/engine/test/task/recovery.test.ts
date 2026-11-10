import { spawnSync } from "node:child_process"
import path from "node:path"
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { InstanceHooks } from "@/project/instance-hooks"
import { Question } from "@/question"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SessionTaskSize } from "@/session/task-size"
import { TaskManager } from "@/task/manager"
import { TaskRecovery } from "@/task/recovery"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { isRecord } from "@/util/record"
import { requireInstance, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// Restart recovery against a fake model server, which must see no request at all: the note it writes is quiet (D.3).

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed([]),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    cloudTools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    remove: () => Effect.void,
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      TaskRecovery.node,
      InstanceHooks.node,
      TaskManager.node,
      SessionPrompt.node,
      Session.node,
      SessionStatus.node,
      Question.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      BackgroundJob.node,
      BackgroundJobStore.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      // Notes reach an idle parent after 50 ms of quiet here.
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, noteQuietMs: 50, noteHoldMs: 300 })],
    ],
  ),
)

const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

function providerConfig(url: string): Partial<ConfigV1.Info> {
  return {
    formatter: false,
    lsp: false,
    provider: {
      lmstudio: {
        name: "Test",
        id: "lmstudio",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

const setup = Effect.fn("RecoveryTest.setup")(function* () {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  const file = path.join(directory, "vector.json")
  yield* fs.writeWithDirs(file, JSON.stringify(providerConfig(llm.url)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  return {
    directory,
    llm,
    sessions: yield* Session.Service,
    store: yield* BackgroundJobStore.Service,
    recovery: yield* TaskRecovery.Service,
  }
})

// A pid that no process holds any more: a child process that has already exited.
const exited = () => spawnSync(process.execPath, ["-e", ""]).pid

// An owner on this machine and boot: another engine whose process is gone, or one still running.
function owner(pid: number): BackgroundJobStore.Owner {
  const here = BackgroundJobStore.current()
  return { runtime: `${crypto.randomUUID()}:${crypto.randomUUID()}`, pid, boot: here.boot, machine: here.machine }
}

// The user's message and the assistant message whose task calls launch helpers, in a root or in a helper's session.
const launchIn = Effect.fn("RecoveryTest.launchIn")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  } satisfies SessionV1.User)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID,
    type: "text",
    text: "Survey the repository.",
  })
  const launch = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  } satisfies SessionV1.Assistant)
  return { id: sessionID, launch: launch.id }
})

const conversation = Effect.fn("RecoveryTest.conversation")(function* () {
  return yield* launchIn((yield* (yield* Session.Service).create({ title: "Root" })).id)
})

// A helper launched by `callID` from `parent`'s launch message, with that call's tool part as `part` left it.
const helper = Effect.fn("RecoveryTest.helper")(function* (
  parent: { id: SessionID; launch: MessageID },
  input: { title: string; callID: string; part?: "running" | "launched"; record?: object },
) {
  const sessions = yield* Session.Service
  const child = yield* sessions.create({
    parentID: parent.id,
    metadata: {
      subagent: {
        kind: "subagent",
        custom: false,
        agent: "general",
        title: input.title,
        parentSessionID: parent.id,
        parentMessageID: parent.launch,
        callID: input.callID,
        model: ref,
        background: input.part === "launched",
        status: "running",
        startedAt: Date.now(),
        attempt: 1,
        ...input.record,
      },
    },
  })
  const start = Date.now()
  if (input.part)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: parent.launch,
      sessionID: parent.id,
      type: "tool",
      callID: input.callID,
      tool: "task",
      state:
        input.part === "running"
          ? { status: "running", input: {}, metadata: { sessionId: child.id, status: "running" }, time: { start } }
          : {
              status: "completed",
              input: {},
              output: "Background task started",
              title: input.title,
              metadata: { sessionId: child.id, status: "running", background: true },
              time: { start, end: start },
            },
    } satisfies SessionV1.ToolPart)
  return child.id
})

// A session nothing has written to for an hour, as an older Vector's helper whose engine is gone.
const idle = (id: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`UPDATE session SET time_updated = ${Date.now() - 60 * 60_000} WHERE id = ${id}`)
  })

// A durable row for a helper's job under `holder`, still running or already interrupted.
const row = Effect.fn("RecoveryTest.row")(function* (
  input: { id: SessionID; parentID: SessionID; directory: string; holder: BackgroundJobStore.Owner; attempt?: number },
  status: "running" | "interrupted" = "running",
) {
  const store = yield* BackgroundJobStore.Service
  yield* store.started({
    id: input.id,
    type: "task",
    title: "Helper",
    parentSessionID: input.parentID,
    sessionID: input.id,
    directory: input.directory,
    background: true,
    attempt: input.attempt ?? 1,
    startedAt: Date.now(),
    owner: input.holder,
  })
  if (status === "interrupted")
    yield* store.settled(input.id, {
      owner: input.holder.runtime,
      attempt: input.attempt ?? 1,
      status: "interrupted",
      completedAt: Date.now(),
    })
})

const record = (id: SessionID) =>
  Effect.gen(function* () {
    return SubagentLifecycle.read(yield* (yield* Session.Service).get(id))
  })

// The tool part of `callID` on a launch message.
const part = (messageID: MessageID, callID: string) =>
  MessageV2.parts(messageID).pipe(
    Effect.map((parts) =>
      parts.find((item): item is SessionV1.ToolPart => item.type === "tool" && item.callID === callID),
    ),
  )

// Every note part in `sessionID` with metadata under `key`.
const notes = (sessionID: SessionID, key: string) =>
  Effect.gen(function* () {
    const messages = yield* (yield* Session.Service).messages({ sessionID })
    return messages.flatMap((message) =>
      message.parts.flatMap((item) =>
        item.type === "text" && isRecord(item.metadata?.[key])
          ? [{ text: item.text, metadata: item.metadata!, value: item.metadata![key] as Record<string, unknown> }]
          : [],
      ),
    )
  })

const interrupted = (sessionID: SessionID, count = 1) =>
  pollWithTimeout(
    notes(sessionID, "taskInterrupted").pipe(Effect.map((found) => (found.length >= count ? found : undefined))),
    "the recovery note never reached the root",
    "5 seconds",
  )

describe("task recovery", () => {
  it.instance(
    "a dead engine's running helpers are reported once to the root, nested under their launcher, with no model request",
    () =>
      Effect.gen(function* () {
        const { llm, store, recovery } = yield* setup()
        const { directory } = yield* requireInstance
        const root = yield* conversation()
        const gone = owner(exited())
        const crashed = { runtimeID: gone.runtime }
        const lead = yield* helper(root, {
          title: "Map the parser",
          callID: "call_lead",
          part: "launched",
          record: crashed,
        })
        const nested = yield* launchIn(lead)
        const scout = yield* helper(nested, {
          title: 'Read "tokens" <task>',
          callID: "call_scout",
          part: "running",
          record: crashed,
        })
        yield* row({ id: lead, parentID: root.id, directory, holder: gone })
        yield* row({ id: scout, parentID: nested.id, directory, holder: gone })

        // As an instance boot runs it.
        yield* (yield* InstanceHooks.Service).init()

        for (const id of [lead, scout])
          expect(yield* record(id)).toMatchObject({
            status: "cancelled",
            reason: SubagentLifecycle.INTERRUPTED_REASON,
            interruption: { cause: "crash", at: expect.any(Number), reportedAt: expect.any(Number) },
          })
        // The background launch's card stops showing it as running; the foreground call becomes an interrupted error.
        expect((yield* part(root.launch, "call_lead"))?.state).toMatchObject({
          status: "completed",
          metadata: { status: "cancelled", interrupted: true },
        })
        expect((yield* part(nested.launch, "call_scout"))?.state).toMatchObject({
          status: "error",
          error: SubagentLifecycle.INTERRUPTED_ERROR,
          metadata: { status: "cancelled", interrupted: true },
        })
        expect((yield* store.forParent(root.id))[0]).toMatchObject({
          status: "interrupted",
          reportedAt: expect.any(Number),
        })

        const [found] = yield* interrupted(root.id)
        expect(found.value).toEqual({ taskIDs: [lead, scout] })
        expect(found.metadata[SessionTaskSize.QUIET]).toBe(true)
        expect(found.text).toContain(`- "Map the parser" (${lead})\n  - "Read 'tokens' <\\task>" (${scout})`)
        expect(found.text).toContain("Nothing restarts on its own.")
        // The nested helper's own launcher gets no note.
        expect(yield* notes(nested.id, "taskInterrupted")).toEqual([])

        // A second pass finds nothing new to report.
        expect(yield* recovery.reconcile()).toEqual({ reported: 0 })
        yield* Effect.sleep("300 millis")
        expect(yield* notes(root.id, "taskInterrupted")).toHaveLength(1)
        expect(yield* llm.calls).toBe(0)
      }),
  )

  it.instance(
    "an interrupted row is reported as a shutdown, while a live engine's helper and another directory's are untouched",
    () =>
      Effect.gen(function* () {
        const { llm, store, recovery } = yield* setup()
        const { directory } = yield* requireInstance
        const root = yield* conversation()
        // The process that started this test is alive, on this machine and boot.
        const [down, running, other] = [owner(exited()), owner(process.ppid), owner(exited())]
        const launched = (title: string, callID: string, holder: BackgroundJobStore.Owner) =>
          helper(root, { title, callID, part: "launched", record: { runtimeID: holder.runtime } })
        const stopped = yield* launched("Stopped by an update", "call_stopped", down)
        const live = yield* launched("Still running elsewhere", "call_live", running)
        const away = yield* launched("Another checkout", "call_away", other)
        yield* row({ id: stopped, parentID: root.id, directory, holder: down }, "interrupted")
        yield* row({ id: live, parentID: root.id, directory, holder: running })
        yield* row({ id: away, parentID: root.id, directory: path.join(directory, "elsewhere"), holder: other })

        expect(yield* recovery.reconcile()).toEqual({ reported: 1 })

        expect((yield* record(stopped))?.interruption?.cause).toBe("shutdown")
        for (const id of [live, away]) {
          expect(yield* record(id)).toMatchObject({ status: "running" })
          expect((yield* record(id))?.interruption).toBeUndefined()
        }
        const rows = yield* store.forParent(root.id)
        expect(rows.find((item) => item.id === live)).toMatchObject({ status: "running" })
        expect(rows.find((item) => item.id === live)?.reportedAt).toBeUndefined()
        expect(rows.find((item) => item.id === away)?.reportedAt).toBeUndefined()
        const [found] = yield* interrupted(root.id)
        expect(found.value).toEqual({ taskIDs: [stopped] })
        expect(yield* llm.calls).toBe(0)
      }),
  )

  it.instance("an older Vector's helpers are reported once, including one the task board already marked", () =>
    Effect.gen(function* () {
      const { llm, recovery } = yield* setup()
      const manager = yield* TaskManager.Service
      const root = yield* conversation()
      const marked = yield* helper(root, {
        title: "Marked by the board",
        callID: "call_marked",
        part: "launched",
        record: { runtimeID: "previous-process" },
      })
      // Listing the board finds it abandoned before recovery runs: its session has been idle.
      yield* idle(marked)
      yield* manager.list({ sessionID: root.id })
      expect((yield* record(marked))?.interruption).toEqual({ at: expect.any(Number), cause: "unknown" })
      const legacy = yield* helper(root, {
        title: "Left running",
        callID: "call_legacy",
        part: "launched",
        record: { runtimeID: "previous-process" },
      })
      yield* idle(legacy)

      expect(yield* recovery.reconcile()).toEqual({ reported: 2 })
      expect(yield* recovery.reconcile()).toEqual({ reported: 0 })

      for (const id of [marked, legacy])
        expect((yield* record(id))?.interruption).toMatchObject({ cause: "unknown", reportedAt: expect.any(Number) })
      const [found] = yield* interrupted(root.id)
      expect(found.value).toEqual({ taskIDs: [marked, legacy] })
      yield* Effect.sleep("300 millis")
      expect(yield* notes(root.id, "taskInterrupted")).toHaveLength(1)
      expect(yield* llm.calls).toBe(0)
    }),
  )

  it.instance("an older Vector's helper whose session is still active is left running until it has been idle", () =>
    Effect.gen(function* () {
      const { llm, recovery } = yield* setup()
      const root = yield* conversation()
      // An older Vector may still be running it: it keeps no lease to probe.
      const busy = yield* helper(root, {
        title: "Still working",
        callID: "call_busy",
        part: "launched",
        record: { runtimeID: "previous-process" },
      })

      expect(yield* recovery.reconcile()).toEqual({ reported: 0 })
      expect(yield* record(busy)).toMatchObject({ status: "running" })
      expect((yield* record(busy))?.interruption).toBeUndefined()
      expect(yield* notes(root.id, "taskInterrupted")).toEqual([])

      yield* idle(busy)
      expect(yield* recovery.reconcile()).toEqual({ reported: 1 })
      expect((yield* record(busy))?.interruption).toMatchObject({ cause: "unknown", reportedAt: expect.any(Number) })
      expect(yield* llm.calls).toBe(0)
    }),
  )

  it.instance(
    "a helper interrupted again after a resume is reported with the new stop's time, before the pass returns",
    () =>
      Effect.gen(function* () {
        const { llm, recovery } = yield* setup()
        const { directory } = yield* requireInstance
        const root = yield* conversation()
        const gone = owner(exited())
        const earlier = Date.now() - 60 * 60_000
        const id = yield* helper(root, {
          title: "Resumed once",
          callID: "call_resumed",
          part: "launched",
          record: {
            runtimeID: gone.runtime,
            attempt: 2,
            interruption: { at: earlier, cause: "crash", reportedAt: earlier, resumedAt: earlier + 1_000 },
          },
        })
        yield* row({ id, parentID: root.id, directory, holder: gone, attempt: 2 })
        const before = Date.now()

        expect(yield* recovery.reconcile()).toEqual({ reported: 1 })
        const interruption = (yield* record(id))?.interruption
        expect(interruption).toMatchObject({ cause: "crash", reportedAt: expect.any(Number) })
        expect(interruption?.at).toBeGreaterThanOrEqual(before)
        expect(interruption?.resumedAt).toBeUndefined()
        // Written by the time the pass returns: a short-lived command exits right after it (no note window).
        expect((yield* notes(root.id, "taskInterrupted")).map((item) => item.value)).toEqual([{ taskIDs: [id] }])
        expect(yield* llm.calls).toBe(0)
      }),
  )

  it.instance(
    "a report a dead engine never delivered arrives once, quietly, even while a human prompt recovers it too",
    () =>
      Effect.gen(function* () {
        const { llm, recovery } = yield* setup()
        const prompt = yield* SessionPrompt.Service
        const report = (parent: { id: SessionID; launch: MessageID }, title: string) =>
          helper(parent, {
            title,
            callID: `call_${title}`,
            part: "launched",
            record: {
              status: "completed",
              runtimeID: "previous-process",
              notification: { text: `${title} report`, state: "completed", launchID: parent.launch },
            },
          })
        // Recovery alone delivers this one.
        const quiet = yield* conversation()
        const alone = yield* report(quiet, "alone")
        // Recovery races the user's next message for this one.
        const busy = yield* conversation()
        const raced = yield* report(busy, "raced")

        yield* Effect.all(
          [
            recovery.reconcile(),
            prompt.prompt({
              sessionID: busy.id,
              agent: "build",
              model: ref,
              noReply: true,
              parts: [{ type: "text", text: "What happened while I was away?" }],
            }),
          ],
          { concurrency: "unbounded" },
        )

        const delivered = yield* pollWithTimeout(
          notes(quiet.id, "taskNotification").pipe(Effect.map((found) => (found.length > 0 ? found : undefined))),
          "the undelivered report never reached its parent",
          "5 seconds",
        )
        // The note also carries the helper's trusted attempt (WP32, 4.6).
        expect(delivered.map((item) => item.value)).toEqual([
          { taskID: alone, state: "completed", attempt: 1, recovered: true, quiet: true },
        ])
        expect(delivered[0].text).toBe("alone report")
        yield* recovery.reconcile()
        yield* Effect.sleep("300 millis")
        expect(yield* notes(quiet.id, "taskNotification")).toHaveLength(1)
        const raced_ = yield* notes(busy.id, "taskNotification")
        expect(raced_.map((item) => item.value)).toEqual([
          expect.objectContaining({ taskID: raced, state: "completed", recovered: true }),
        ])
        expect(yield* llm.calls).toBe(0)
      }),
  )

  it.instance("an archived root's helpers are reported without a note", () =>
    Effect.gen(function* () {
      const { llm, sessions, recovery } = yield* setup()
      const { directory } = yield* requireInstance
      const root = yield* conversation()
      const holder = owner(exited())
      const id = yield* helper(root, {
        title: "Archived work",
        callID: "call_archived",
        part: "launched",
        record: { runtimeID: holder.runtime },
      })
      yield* row({ id, parentID: root.id, directory, holder })
      yield* sessions.setArchived({ sessionID: root.id, time: Date.now() })

      expect(yield* recovery.reconcile()).toEqual({ reported: 1 })
      expect((yield* record(id))?.interruption).toMatchObject({ cause: "crash", reportedAt: expect.any(Number) })
      yield* Effect.sleep("300 millis")
      expect(yield* notes(root.id, "taskInterrupted")).toEqual([])
      expect(yield* llm.calls).toBe(0)
    }),
  )
})
