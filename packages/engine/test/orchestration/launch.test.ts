import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { SubagentRecord, SubagentUsage } from "@/agent/subagent-kind"
import { WorkflowMarkers } from "@/orchestration/constants"
import { WorkflowLaunch } from "@/orchestration/launch"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)
const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, Database.node, SessionProjector.node, CrossSpawnSpawner.node])),
)
const model = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("workflow-launch-fixture") }
const usage: SubagentUsage = {
  cost: 0.25,
  steps: 1,
  toolUses: 0,
  total: 15,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
}
const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
}
type Options = {
  readonly status?: SubagentRecord["status"]
  readonly failBefore?: boolean
  readonly failAfter?: boolean
  readonly structured?: unknown
  readonly extraText?: boolean
  readonly entered?: Deferred.Deferred<SessionID>
  readonly release?: Deferred.Deferred<void>
}

/** Only execution is injected; all messages, parts and lifecycle records use real Session storage. */
const fixture = Effect.fnUntraced(function* (options: Options = {}) {
  const sessions = yield* Session.Service
  const instance = yield* TestInstance
  const parent = yield* sessions.create({ title: "Workflow parent" })
  const run = yield* sessions.create({
    parentID: parent.id,
    title: "Workflow run",
    agent: WorkflowMarkers.WORKFLOW_AGENT,
  })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: run.id,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  const observed: { args: Parameters<WorkflowLaunch.Input["task"]["execute"]>[0]; context: Tool.Context }[] = []
  const cancelled: SessionID[] = []
  const unexpected: string[] = []
  const ops: TaskPromptOps = {
    cancel: (id) =>
      Effect.gen(function* () {
        cancelled.push(id)
        yield* SubagentLifecycle.write(sessions, id, { status: "cancelled" }).pipe(Effect.orDie)
      }),
    prompt: () =>
      Effect.sync(() => unexpected.push("prompt")).pipe(
        Effect.andThen(Effect.die(new Error("Launch must not call a provider or repair a child itself."))),
      ),
    resolvePromptParts: () =>
      Effect.sync(() => unexpected.push("resolvePromptParts")).pipe(
        Effect.andThen(Effect.die(new Error("Task execution owns prompt resolution."))),
      ),
  }
  const task: WorkflowLaunch.Input["task"] = {
    execute: (args, context) =>
      Effect.gen(function* () {
        observed.push({ args, context })
        if (options.failBefore) return yield* Effect.die(new Error("Task admission failed before child creation"))
        const child = yield* sessions.create({
          parentID: run.id,
          agent: "general",
          metadata: {
            [SubagentLifecycle.METADATA_KEY]: {
              kind: "subagent",
              custom: false,
              agent: "general",
              title: "Fixture task",
              parentSessionID: run.id,
              parentMessageID: context.messageID,
              callID: context.callID,
              model,
              background: false,
              status: "running",
              startedAt: Date.now(),
              runtimeID: "launch-test",
              attempt: 1,
            } satisfies SubagentRecord,
          },
        })
        yield* context.metadata({ title: "Fixture task", metadata: { sessionId: child.id } })
        if (options.entered) yield* Deferred.succeed(options.entered, child.id)
        if (options.release) yield* Deferred.await(options.release)
        const status = options.failAfter ? "error" : (options.status ?? "completed")
        yield* SubagentLifecycle.write(sessions, child.id, {
          status,
          usage,
          ...(status === "error" ? { error: "Child execution failed" } : {}),
        })
        if (options.failAfter) return yield* Effect.die(new Error("Child execution failed"))
        if (status === "completed") {
          const prompt = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: child.id,
            agent: "general",
            model,
            time: { created: Date.now() },
          })
          const answer = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            parentID: prompt.id,
            sessionID: child.id,
            mode: "general",
            agent: "general",
            modelID: model.modelID,
            providerID: model.providerID,
            path: { cwd: instance.directory, root: instance.directory },
            cost: usage.cost,
            tokens: usage.tokens,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
            ...(options.structured === undefined ? {} : { structured: options.structured }),
          } satisfies SessionV1.Assistant)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: answer.id,
            sessionID: child.id,
            type: "text",
            text: "Saved task answer",
          })
          if (options.extraText) {
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: answer.id,
              sessionID: child.id,
              type: "text",
              text: "Synthetic content",
              synthetic: true,
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: answer.id,
              sessionID: child.id,
              type: "text",
              text: "Ignored content",
              ignored: true,
            })
          }
        }
        return {
          title: "Fixture task",
          output: "Wrapped task result",
          metadata: {
            parentSessionId: run.id,
            sessionId: child.id,
            projectId: run.projectID,
            directory: run.directory,
            model,
            modelSource: "call" as const,
            kind: "subagent" as const,
            agent: "general",
            custom: false,
            title: "Fixture task",
            parentMessageId: context.messageID,
            startedAt: Date.now(),
            batchID: `${run.id}:${context.callID}`,
            attempt: 1,
            status,
            truncated: false,
            ...(status === "running" ? { background: true, jobId: child.id } : {}),
          },
        }
      }).pipe(Effect.orDie),
  }
  const launcher = WorkflowLaunch.make({
    sessions,
    task,
    ops,
    runID: run.id,
    message: {
      parentID: user.id,
      modelID: model.modelID,
      providerID: model.providerID,
      path: { cwd: instance.directory, root: instance.directory },
    },
    ask: () => Effect.die(new Error("Injected task did not ask permission.")),
    extra: { fixture: true },
  })
  const request = (index = 0): WorkflowLaunch.Request => ({
    marker: {
      runID: run.id,
      stage: "review",
      phase: "inspect",
      item: `item-${index}`,
      key: `key-${index}`,
      round: 0,
      verifier: false,
    },
    title: "Review one file",
    prompt: "Review src/file.ts",
    agent: "general",
    model: "local-test/workflow-launch-fixture",
    effort: "low",
    isolation: "worktree",
    ownedPaths: ["src/file.ts"],
    successCriteria: ["Report findings"],
    budget: { usd: 2, steps: 10 },
  })
  const stored = () => sessions.messages({ sessionID: run.id })
  const parts = () =>
    stored().pipe(
      Effect.map((messages) =>
        messages.flatMap((message) => message.parts).filter((part): part is SessionV1.ToolPart => part.type === "tool"),
      ),
    )
  return { sessions, parent, run, launcher, request, observed, cancelled, unexpected, stored, parts }
})

describe("workflow node launch persistence", () => {
  it.instance("creates zero-cost assistant/task parts and forwards the trusted execution fields", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ extraText: true })
      const seen: SessionID[] = []
      const request = f.request()
      const result = yield* f.launcher.node(request, (id) =>
        Effect.sync(() => {
          seen.push(id)
        }),
      )
      expect(result).toMatchObject({ status: "completed", output: "Saved task answer", usage })
      expect(seen).toEqual([result.sessionID!])
      expect(result.messageID).toBe(
        (yield* f.sessions.messages({ sessionID: result.sessionID! })).findLast(
          (message) => message.info.role === "assistant",
        )?.info.id,
      )
      expect(f.observed).toHaveLength(1)
      expect(f.observed[0].args).toMatchObject({
        description: request.title,
        prompt: request.prompt,
        subagent_type: "general",
        background: false,
        model: request.model,
        effort: "low",
        isolation: "worktree",
        owned_paths: ["src/file.ts"],
        success_criteria: ["Report findings"],
        budget: { usd: 2, steps: 10 },
      })
      expect(f.observed[0].context).toMatchObject({
        sessionID: f.run.id,
        agent: "workflow",
        extra: { fixture: true, [WorkflowMarkers.AGENT]: request.marker },
      })
      const messages = (yield* f.stored()).filter((message) => message.info.role === "assistant")
      expect(messages).toHaveLength(1)
      expect(messages[0].info).toMatchObject({
        agent: "workflow",
        mode: "workflow",
        cost: 0,
        tokens: { input: 0, output: 0 },
      })
      const parts = yield* f.parts()
      expect(parts).toHaveLength(1)
      expect(parts[0]).toMatchObject({
        tool: "task",
        metadata: { workflow: request.marker },
        state: { status: "completed", output: "Wrapped task result" },
      })
      expect(f.unexpected).toEqual([])
    }),
  )

  it.instance("rolls over after fifty task parts and writes the final report to the current message", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      for (let i = 0; i < 51; i++) yield* f.launcher.node(f.request(i), () => Effect.void)
      yield* f.launcher.finish("Workflow completed.\nFull results: /fixture/results.json")
      const messages = (yield* f.stored()).filter((message) => message.info.role === "assistant")
      expect(messages).toHaveLength(2)
      expect(messages.map((message) => message.parts.filter((part) => part.type === "tool").length)).toEqual([50, 1])
      expect(messages[0].info).toMatchObject({ finish: "tool-calls" })
      expect(messages[1].info).toMatchObject({ finish: "stop" })
      expect(messages[1].parts.some((part) => part.type === "text" && part.text.includes("Full results:"))).toBe(true)
      expect((yield* f.parts()).every((part) => part.state.status === "completed")).toBe(true)
    }),
  )

  it.instance("registers the child session while the task is still running", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const registered = yield* Deferred.make<SessionID>()
      const f = yield* fixture({ release })
      const fiber = yield* f.launcher
        .node(f.request(), (id) => Deferred.succeed(registered, id).pipe(Effect.asVoid))
        .pipe(Effect.forkChild)
      const child = yield* Deferred.await(registered)
      expect(SubagentLifecycle.read(yield* f.sessions.get(child))?.status).toBe("running")
      expect((yield* f.parts())[0].state.status).toBe("running")
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(fiber)).status).toBe("completed")
    }),
  )

  it.instance("settles an ordinary failure before child creation", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ failBefore: true })
      const seen: SessionID[] = []
      const result = yield* f.launcher.node(f.request(), (id) =>
        Effect.sync(() => {
          seen.push(id)
        }),
      )
      expect(result.status).toBe("failed")
      expect(result.sessionID).toBeUndefined()
      expect(result.error).toContain("admission failed")
      expect((yield* f.parts())[0].state).toMatchObject({
        status: "error",
        error: expect.stringContaining("admission failed"),
      })
      expect(seen).toEqual([])
    }),
  )

  it.instance("retains the child identity and accounting when execution fails after registration", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ failAfter: true })
      const seen: SessionID[] = []
      const result = yield* f.launcher.node(f.request(), (id) =>
        Effect.sync(() => {
          seen.push(id)
        }),
      )
      expect(result).toMatchObject({ status: "failed", usage })
      expect(seen).toEqual([result.sessionID!])
      expect((yield* f.parts())[0].state).toMatchObject({
        status: "error",
        error: expect.stringContaining("Child execution failed"),
      })
      expect(f.unexpected).toEqual([])
    }),
  )

  it.instance("interruption cancels the registered child and settles the running part", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<SessionID>()
      const release = yield* Deferred.make<void>()
      const f = yield* fixture({ entered, release })
      const fiber = yield* f.launcher.node(f.request(), () => Effect.void).pipe(Effect.forkChild)
      const child = yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
      expect(f.cancelled).toEqual([child])
      expect(f.observed[0].context.abort.aborted).toBe(true)
      expect((yield* f.parts())[0].state).toMatchObject({
        status: "error",
        error: "Interrupted",
        metadata: { interrupted: true },
      })
      expect(SubagentLifecycle.read(yield* f.sessions.get(child))?.status).toBe("cancelled")
    }),
  )

  it.instance("a promoted child that is still running is cancelled and refused", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ status: "running" })
      const result = yield* f.launcher.node(f.request(), () => Effect.void)
      expect(result).toMatchObject({
        status: "cancelled",
        retryable: false,
        error: "Workflow task did not settle its child.",
      })
      expect(f.cancelled).toEqual([result.sessionID!])
      expect((yield* f.parts())[0].state.status).toBe("error")
    }),
  )

  it.instance("a user-stopped child never enters structured repair", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ status: "cancelled" })
      const result = yield* f.launcher.node({ ...f.request(), outputSchema: schema }, () => Effect.void)
      expect(result.status).toBe("cancelled")
      expect(f.observed).toHaveLength(1)
      expect(f.unexpected).toEqual([])
      expect((yield* f.parts())[0].state.status).toBe("error")
    }),
  )

  it.instance("invalid structured output is rejected and does not leave a completed task part", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ structured: { ok: "wrong-type" } })
      const result = yield* f.launcher.node({ ...f.request(), outputSchema: schema }, () => Effect.void)
      expect(result.status).toBe("failed")
      expect(result.error).toContain("valid structured output")
      expect((yield* f.parts())[0].state.status).toBe("error")
      expect(f.unexpected).toEqual([])
    }),
  )

  it.instance("valid structured output is read from the saved child answer", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ structured: { ok: true } })
      const result = yield* f.launcher.node({ ...f.request(), outputSchema: schema }, () => Effect.void)
      expect(result).toMatchObject({ status: "completed", output: { ok: true } })
      expect((yield* f.parts())[0].state.status).toBe("completed")
    }),
  )
})
