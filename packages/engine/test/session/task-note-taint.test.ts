import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { Database } from "@vectordevai/core/database/database"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionMemory } from "@/session/memory"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { DesktopTasks } from "@/task/desktop"
import { TaskLimits } from "@/task/limits"
import { TaskManager } from "@/task/manager"
import { TaskNotify } from "@/task/notify"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { WorkflowRuns } from "@/orchestration/runs"
import { fixture as workflowFixture, layer as workflowLayer, spec as workflowSpec } from "../tool/workflow-fixture"

// Taint between helpers (D.6): what a helper took in from the web or an MCP server follows its notes and messages, so
// the agent that reads them is held for the same reason (I14).

afterEach(disposeAllInstances)

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      TaskManager.node,
      TaskLimits.node,
      TaskNotify.node,
      Session.node,
      SessionStatus.node,
      BackgroundJob.node,
      Database.node,
      DesktopTasks.node,
      Storage.node,
      SpendGuard.node,
    ]),
    // Notes reach an idle parent after 50 ms of quiet here, held at most 300 ms while its helpers run.
    [[RuntimeFlags.node, RuntimeFlags.layer({ noteQuietMs: 50, noteHoldMs: 300 })]],
  ),
)

const model = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("fixture") }
let counter = 0
const unique = (prefix: string) => `${prefix}_note_taint_${++counter}`

/** One user message holding `parts`, as a note reaches a parent. */
function noted(parts: ReadonlyArray<{ text: string; metadata: Record<string, unknown> }>): SessionV1.WithParts[] {
  const sessionID = SessionID.make("ses_note_taint")
  const id = MessageID.make(unique("msg"))
  return [
    {
      info: { id, sessionID, role: "user", time: { created: 1 }, agent: "build", model },
      parts: parts.map((part) => ({
        id: PartID.make(unique("prt")),
        messageID: id,
        sessionID,
        type: "text" as const,
        synthetic: true,
        text: part.text,
        metadata: part.metadata,
      })),
    },
  ]
}

/** One assistant message that ran `tool` with `metadata`, as a finished task call does. */
function called(tool: string, metadata: Record<string, unknown>): SessionV1.WithParts[] {
  const sessionID = SessionID.make("ses_note_taint")
  const id = MessageID.make(unique("msg"))
  return [
    {
      info: {
        id,
        sessionID,
        role: "assistant",
        parentID: MessageID.make(unique("msg")),
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        time: { created: 2 },
      },
      parts: [
        {
          id: PartID.make(unique("prt")),
          messageID: id,
          sessionID,
          type: "tool",
          callID: unique("call"),
          tool,
          state: { status: "completed", input: {}, output: "", title: tool, metadata, time: { start: 0, end: 1 } },
        },
      ],
    },
  ]
}

describe("note taint", () => {
  test("taskMessage, taskAttention and taskInterrupted taint subagent; a background command's note adds nothing", () => {
    for (const metadata of [
      { taskMessage: { taskID: "ses_child" } },
      { taskAttention: { taskID: "ses_child", kind: "permission", state: "waiting" } },
      { taskInterrupted: { taskIDs: ["ses_child"] } },
      { taskNotification: { taskID: "ses_child", state: "completed" } },
    ])
      expect(SessionMemory.taint(noted([{ text: "A note", metadata }]))).toBe("subagent")
    expect(
      SessionMemory.taint(
        noted([{ text: "Exited", metadata: { shellNotification: { shellID: "shl_1", state: "completed" } } }]),
      ),
    ).toBeUndefined()
  })

  test("a part with HOLD mcp keeps mcp, and web content still wins", () => {
    // A task call whose subagent ran an MCP tool, and a note about one.
    expect(SessionMemory.taint(called("task", { [SessionMemory.HOLD]: "mcp" }))).toBe("mcp")
    const note = { taskNotification: { taskID: "ses_child", state: "completed" }, ...SessionMemory.carried("mcp") }
    expect(note).toMatchObject({ [BrainSchema.OUTSIDE]: "subagent", [SessionMemory.HOLD]: "mcp" })
    expect(SessionMemory.taint(noted([{ text: "Report", metadata: note }]))).toBe("mcp")
    // A note from a helper that read the web is outside content.
    const web = { taskMessage: { taskID: "ses_child" }, ...SessionMemory.carried("web") }
    expect(SessionMemory.taint(noted([{ text: "Report", metadata: web }]))).toBe("web")
    expect(
      SessionMemory.taint([
        ...called("task", { [SessionMemory.HOLD]: "mcp" }),
        ...noted([{ text: "Report", metadata: web }]),
      ]),
    ).toBe("web")
    // Only web and MCP holds travel this way: the note's own key already says subagent.
    expect(SessionMemory.carried("subagent")).toEqual({})
    expect(SessionMemory.carried(undefined)).toEqual({})
  })

  it.instance("a web-tainted peer's message makes the recipient's completion carry hold web", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const manager = yield* TaskManager.Service
      const jobs = yield* BackgroundJob.Service
      const statuses = yield* SessionStatus.Service
      const notify = yield* TaskNotify.Service
      const root = yield* sessions.create()
      const launch = MessageID.ascending()
      yield* sessions.updateMessage({
        id: launch,
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID: root.id,
        agent: "build",
        mode: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        modelID: model.modelID,
        providerID: model.providerID,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      const child = (title: string) =>
        sessions.create({
          parentID: root.id,
          metadata: {
            subagent: {
              kind: "subagent",
              custom: false,
              agent: "general",
              title,
              parentSessionID: root.id,
              parentMessageID: launch,
              model,
              background: true,
              status: "running",
              startedAt: Date.now(),
              runtimeID: SubagentLifecycle.RUNTIME_ID,
              attempt: 1,
            },
          },
        })
      const reader = yield* child("Read the vendor docs")
      const builder = yield* child("Build the client")
      // The reader fetched a page.
      const fetched = MessageID.ascending()
      yield* sessions.updateMessage({
        id: fetched,
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID: reader.id,
        agent: "general",
        mode: "general",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        modelID: model.modelID,
        providerID: model.providerID,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: reader.id,
        messageID: fetched,
        type: "tool",
        callID: "call_fetch",
        tool: "webfetch",
        state: {
          status: "completed",
          input: {},
          output: "page",
          title: "docs",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      })
      expect(SessionMemory.taint(yield* sessions.messages({ sessionID: reader.id }))).toBe("web")

      // Every prompt writes what it was given, as SessionPrompt would.
      const prompts: SessionPrompt.PromptInput[] = []
      const writes: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
        prompt: (input) =>
          Effect.gen(function* () {
            prompts.push(input)
            const messageID = input.messageID ?? MessageID.ascending()
            yield* sessions.updateMessage({
              id: messageID,
              role: "user",
              sessionID: input.sessionID,
              agent: "build",
              model,
              time: { created: Date.now() },
            })
            for (const part of input.parts)
              if (part.type === "text")
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  sessionID: input.sessionID,
                  messageID,
                  type: "text",
                  text: part.text,
                  synthetic: part.synthetic,
                  metadata: part.metadata,
                })
            return {
              info: {
                id: MessageID.ascending(),
                role: "assistant",
                parentID: messageID,
                sessionID: input.sessionID,
                agent: "build",
                mode: "build",
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                modelID: model.modelID,
                providerID: model.providerID,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: Date.now() },
              },
              parts: [],
            } satisfies SessionV1.WithParts
          }).pipe(Effect.orDie),
      }

      // The builder runs in the background, and its completion is reported to the root.
      const gate = yield* Deferred.make<void>()
      yield* jobs.start({
        id: builder.id,
        type: "task",
        metadata: { parentSessionId: root.id, background: true },
        run: Deferred.await(gate).pipe(Effect.as("Built the client")),
      })
      yield* statuses.set(builder.id, { type: "busy" })
      yield* notify.watch({
        jobID: builder.id,
        parentID: root.id,
        taskID: builder.id,
        attempt: 1,
        title: "Build the client",
        startedAt: Date.now(),
        launchID: launch,
        ops: writes,
        agent: "build",
      })

      // The reader tells its sibling what the page said.
      yield* manager.message(
        { sessionID: reader.id, taskID: builder.id, text: "The docs say: use the v2 endpoint" },
        writes,
      )
      const delivered = yield* pollWithTimeout(
        Effect.sync(() => prompts.find((input) => input.sessionID === builder.id)),
        "the message must reach the builder",
      )
      const envelope = delivered.parts[0]
      if (envelope?.type !== "text") throw new Error("Expected the message envelope")
      expect(envelope.metadata).toEqual({ [BrainSchema.OUTSIDE]: "subagent", [SessionMemory.HOLD]: "web" })
      expect(SessionMemory.taint(yield* sessions.messages({ sessionID: builder.id }))).toBe("web")

      // The builder finishes, and its completion note carries the hold to the root.
      yield* Deferred.succeed(gate, undefined)
      const note = yield* pollWithTimeout(
        Effect.sync(() => prompts.find((input) => input.sessionID === root.id)),
        "the builder's completion must reach the root",
      )
      const part = note.parts[0]
      if (part?.type !== "text") throw new Error("Expected the completion note")
      expect(part.metadata).toMatchObject({
        taskNotification: { taskID: builder.id, state: "completed" },
        [BrainSchema.OUTSIDE]: "subagent",
        [SessionMemory.HOLD]: "web",
      })
      expect(SessionMemory.taint(yield* sessions.messages({ sessionID: root.id }))).toBe("web")
    }),
  )

  it.instance("the user's own message to a helper carries nothing, whatever the root read", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const manager = yield* TaskManager.Service
      const jobs = yield* BackgroundJob.Service
      const statuses = yield* SessionStatus.Service
      const root = yield* sessions.create()
      const searched = MessageID.ascending()
      yield* sessions.updateMessage({
        id: searched,
        role: "assistant",
        parentID: MessageID.ascending(),
        sessionID: root.id,
        agent: "build",
        mode: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        modelID: model.modelID,
        providerID: model.providerID,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: root.id,
        messageID: searched,
        type: "tool",
        callID: "call_search",
        tool: "websearch",
        state: {
          status: "completed",
          input: {},
          output: "results",
          title: "search",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      })
      const helper = yield* sessions.create({
        parentID: root.id,
        metadata: {
          subagent: {
            kind: "subagent",
            custom: false,
            agent: "general",
            title: "Write the tests",
            parentSessionID: root.id,
            parentMessageID: searched,
            model,
            background: true,
            status: "running",
            startedAt: Date.now(),
            runtimeID: SubagentLifecycle.RUNTIME_ID,
            attempt: 1,
          },
        },
      })
      yield* jobs.start({ id: helper.id, type: "task", run: Effect.never })
      yield* statuses.set(helper.id, { type: "busy" })
      const sent: SessionPrompt.PromptInput[] = []
      const ops: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
        prompt: (input) =>
          Effect.sync(() => {
            sent.push(input)
            return {
              info: {
                id: MessageID.ascending(),
                role: "assistant",
                parentID: MessageID.ascending(),
                sessionID: input.sessionID,
                agent: "build",
                mode: "build",
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                modelID: model.modelID,
                providerID: model.providerID,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: Date.now() },
              },
              parts: [],
            } satisfies SessionV1.WithParts
          }),
      }
      yield* manager.message(
        { sessionID: root.id, taskID: helper.id, text: "Cover the error path", origin: "user" },
        ops,
      )
      yield* manager.message({ sessionID: root.id, taskID: helper.id, text: "Use the search results" }, ops)
      yield* pollWithTimeout(
        Effect.sync(() => (sent.length === 2 ? true : undefined)),
        "both messages must be delivered",
      )
      const metadata = (text: string) =>
        sent
          .flatMap((input) => input.parts)
          .flatMap((part) => (part.type === "text" && part.text.includes(text) ? [part.metadata] : []))[0]
      // The user wrote the first; the root agent, which searched the web, wrote the second.
      expect(metadata("Cover the error path")).toBeUndefined()
      expect(metadata("Use the search results")).toEqual({
        [BrainSchema.OUTSIDE]: "subagent",
        [SessionMemory.HOLD]: "web",
      })
      yield* jobs.cancel(helper.id)
    }),
  )
})

// A workflow agent's web or MCP read rides on the coordinator's task part to the run's own note, which carries it to
// the conversation that started the run (I14).
const workflows = testEffect(workflowLayer())
for (const [tool, hold] of [
  ["webfetch", "web"],
  ["mcp_fixture", "mcp"],
] as const)
  workflows.instance(
    `a workflow agent's ${tool} read reaches the parent's run note as hold ${hold}`,
    () =>
      Effect.gen(function* () {
        const f = yield* workflowFixture()
        const runs = yield* WorkflowRuns.Service
        const jobs = yield* BackgroundJob.Service
        const ctx = {
          ...f.ctx,
          extra: {
            ...f.ctx.extra,
            promptOps: {
              ...f.ops,
              prompt: (input: Parameters<typeof f.ops.prompt>[0]) =>
                Effect.gen(function* () {
                  const child = yield* f.sessions.get(input.sessionID)
                  if (SubagentLifecycle.read(child)?.workflow?.role === "agent") {
                    // The agent reads outside content before it answers.
                    const read = MessageID.ascending()
                    yield* f.sessions.updateMessage({
                      id: read,
                      role: "assistant",
                      parentID: MessageID.ascending(),
                      sessionID: input.sessionID,
                      agent: "explore",
                      mode: "explore",
                      cost: 0,
                      path: { cwd: "/tmp", root: "/tmp" },
                      modelID: model.modelID,
                      providerID: model.providerID,
                      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                      time: { created: Date.now(), completed: Date.now() },
                    })
                    yield* f.sessions.updatePart({
                      id: PartID.ascending(),
                      sessionID: input.sessionID,
                      messageID: read,
                      type: "tool",
                      callID: `call_${tool}`,
                      tool,
                      state: {
                        status: "completed",
                        input: {},
                        output: "Outside content",
                        title: tool,
                        metadata: {},
                        time: { start: 0, end: 1 },
                      },
                    })
                  }
                  return yield* f.ops.prompt(input)
                }),
            },
          },
        }
        const started = yield* runs.launch({ ctx, input: { spec: JSON.stringify(workflowSpec) }, task: f.task })
        yield* jobs.wait({ id: started.runID })
        const note = yield* pollWithTimeout(
          f.sessions
            .messages({ sessionID: f.parent.id })
            .pipe(
              Effect.map((messages) =>
                messages
                  .flatMap((message) => message.parts)
                  .find(
                    (part) =>
                      part.type === "text" &&
                      (part.metadata?.taskNotification as { taskID?: string } | undefined)?.taskID === started.runID,
                  ),
              ),
            ),
          "the run's completion note must reach the parent",
        )
        expect(note.type === "text" && note.metadata).toMatchObject({
          [BrainSchema.OUTSIDE]: "subagent",
          [SessionMemory.HOLD]: hold,
        })
        expect(SessionMemory.taint(yield* f.sessions.messages({ sessionID: f.parent.id }))).toBe(hold)
      }),
    { trusted: true },
  )
