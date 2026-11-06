import path from "node:path"
import { readFile } from "node:fs/promises"
import { afterEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { TaskNotify } from "@/task/notify"
import { TaskLimits } from "@/task/limits"
import { TaskManager } from "@/task/manager"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { ResearchRun } from "@/tool/research-run"
import { isRecord } from "@/util/record"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

// output_schema on task (multi-agent contract 5.E.2): a schema Vector cannot check is refused before anything starts; a
// fresh child answers through StructuredOutput, a run that ends without a value is asked once more, and the parent
// receives the last run's value as whole JSON or as the file holding it, never a cut one.

afterEach(async () => {
  await disposeAllInstances()
})

const lmstudio = ProviderV2.ID.make("lmstudio")
const big = { providerID: lmstudio, modelID: ModelV2.ID.make("big") }

const tools = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionRevert.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      Provider.node,
      SpendGuard.node,
      TaskNotify.node,
      TaskLimits.node,
      TaskManager.node,
      FreeModelGuests.node,
      BackgroundJobStore.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ noteQuietMs: 50, noteHoldMs: 300 })]],
  ),
)

const config = {
  provider: {
    lmstudio: {
      name: "Test",
      id: "lmstudio",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
      models: {
        big: {
          id: "big",
          name: "big",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 1, output: 5 },
        },
      },
    },
  },
}

const SCHEMA = {
  type: "object",
  properties: { routes: { type: "array", items: { type: "string" } } },
  required: ["routes"],
  additionalProperties: false,
}

const seed = Effect.fn("TaskStructuredTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Routes" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: big,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: big.modelID,
    providerID: lmstudio,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

// What one child run writes: StructuredOutput calls, each its own step, then a final message with the kept value, text,
// or the loop's error for a run that ended without the call.
type Answer = { calls?: number; value?: unknown; text?: string; missed?: boolean }

const assistantOf = (
  input: SessionPrompt.PromptInput,
  extra: Partial<SessionV1.Assistant> = {},
): SessionV1.Assistant => ({
  id: MessageID.ascending(),
  role: "assistant",
  parentID: input.messageID ?? MessageID.ascending(),
  sessionID: input.sessionID,
  mode: input.agent ?? "general",
  agent: input.agent ?? "general",
  cost: 0,
  path: { cwd: "/tmp", root: "/tmp" },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: input.model?.modelID ?? big.modelID,
  providerID: input.model?.providerID ?? lmstudio,
  time: { created: Date.now() },
  finish: "stop",
  ...extra,
})

const write = Effect.fn("TaskStructuredTest.write")(function* (input: SessionPrompt.PromptInput, answer: Answer) {
  const sessions = yield* Session.Service
  for (let call = 0; call < (answer.calls ?? 0); call++) {
    const step = yield* sessions.updateMessage(assistantOf(input, { finish: "tool-calls" }))
    const now = Date.now()
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: step.id,
      type: "tool",
      callID: `call_${step.id}`,
      tool: "StructuredOutput",
      state: {
        status: "completed",
        input: {},
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
        time: { start: now, end: now },
      },
    })
  }
  const info = yield* sessions.updateMessage(
    assistantOf(input, {
      ...(answer.value === undefined ? {} : { structured: answer.value }),
      ...(answer.missed
        ? {
            error: new SessionV1.StructuredOutputError({
              message: "Model did not produce structured output",
              retries: 0,
            }).toObject(),
          }
        : {}),
    }),
  )
  const parts: SessionV1.Part[] = []
  if (answer.text)
    parts.push(
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: input.sessionID,
        messageID: info.id,
        type: "text",
        text: answer.text,
      }),
    )
  return { info, parts } satisfies SessionV1.WithParts
})

/** Ops whose child runs answer from `script` in order, and whose parent notes are only recorded. */
function scripted(
  parentID: SessionID,
  prompts: SessionPrompt.PromptInput[],
  script: ((input: SessionPrompt.PromptInput) => Effect.Effect<Answer>)[],
  session: Session.Interface,
): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        prompts.push(input)
        if (input.sessionID === parentID) return { info: assistantOf(input), parts: [] }
        const next = script.shift()
        const answer = next ? yield* next(input) : { text: "nothing scripted" }
        return yield* write(input, answer).pipe(Effect.provideService(Session.Service, session))
      }),
  }
}

const answer = (value: Answer) => () => Effect.succeed(value)

function context(input: { sessionID: SessionID; messageID: MessageID; ops: TaskPromptOps; asks: unknown[] }) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: "call_task",
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps: input.ops },
    messages: [],
    metadata: () => Effect.void,
    ask: (request: unknown) =>
      Effect.sync(() => {
        input.asks.push(request)
      }),
  }
}

const text = (input: SessionPrompt.PromptInput) =>
  input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

const childPrompts = (prompts: SessionPrompt.PromptInput[], id: SessionID) =>
  prompts.filter((input) => input.sessionID === id)

const failure = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")

// The parent's note about a background child, once it lands.
const noteFor = (prompts: SessionPrompt.PromptInput[], parentID: SessionID) =>
  pollWithTimeout(
    Effect.sync(() =>
      prompts
        .filter((input) => input.sessionID === parentID)
        .map(text)
        .find((value) => value.includes("<task-notification")),
    ),
    "the parent must get the child's note",
  )

const brief = { description: "List routes", prompt: "List the HTTP routes the server registers." }

describe("task output_schema", () => {
  tools.instance(
    "an invalid or oversized schema is refused before start, and a researcher with a schema is refused",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const asks: unknown[] = []
        const ctx = context({
          sessionID: chat.id,
          messageID: assistant.id,
          ops: scripted(chat.id, prompts, [], sessions),
          asks,
        })
        const refused = [
          [{ type: "object", properties: { id: { type: "string", pattern: "^r" } } }, '"pattern" is not supported'],
          [{ type: "object", description: "x".repeat(17 * 1024) }, "larger than 16 KiB"],
          [{ type: "array" }, 'The root must be "type": "object"'],
        ] as const
        for (const [schema, reason] of refused) {
          const exit = yield* Effect.exit(def.execute({ ...brief, output_schema: schema }, ctx))
          expect(failure(exit)).toContain("Vector cannot check this output_schema")
          expect(failure(exit)).toContain(reason)
        }
        const researcher = yield* Effect.exit(
          def.execute({ ...brief, subagent_type: ResearchRun.RESEARCHER, output_schema: SCHEMA }, ctx),
        )
        expect(failure(researcher)).toContain(
          `The ${ResearchRun.RESEARCHER} agent writes the report its research run asks for; leave output_schema out.`,
        )
        // Beside a batch's array it is refused at decode, saying where it goes.
        const beside = yield* Effect.exit(def.execute({ tasks: [brief], output_schema: SCHEMA } as never, ctx))
        expect(failure(beside)).toContain("goes inside each tasks entry, not beside the array.")
        expect(asks).toHaveLength(0)
        expect(prompts).toHaveLength(0)
        expect(yield* sessions.children(chat.id)).toHaveLength(0)
      }),
    { trusted: true, config },
  )

  tools.instance(
    'a valid value gives <task_result format="json"> and structured.valid, in the foreground, a note and a hand-off',
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const value = { routes: ["/health", "/<admin>"] }
        const ops = scripted(
          chat.id,
          prompts,
          [answer({ calls: 1, value }), answer({ calls: 1, value: { routes: ["/later"] } }), answer({ text: "ok" })],
          sessions,
        )
        const ctx = context({ sessionID: chat.id, messageID: assistant.id, ops, asks: [] })

        const result = yield* def.execute({ ...brief, background: false, output_schema: SCHEMA }, ctx)
        const [child] = yield* sessions.children(chat.id)
        expect(childPrompts(prompts, child!.id)[0]!.format).toMatchObject({
          type: "json_schema",
          schema: SCHEMA,
          retryCount: 2,
        })
        // Escaped as encode writes it, so the value cannot close the element around it.
        expect(result.output).toContain(
          '<task_result format="json">\n{"routes":["/health","/\\u003cadmin\\u003e"]}\n</task_result>',
        )
        expect(result.metadata).toMatchObject({ structured: { valid: true, attempts: 1 } })
        expect(SubagentLifecycle.read(yield* sessions.get(child!.id))?.structured).toEqual({
          schema: SCHEMA,
          schemaHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          attempts: 1,
          valid: true,
        })

        // A background child's note carries the value the same way.
        yield* def.execute({ ...brief, description: "List later routes", output_schema: SCHEMA }, ctx)
        const note = yield* noteFor(prompts, chat.id)
        expect(note).toContain('<task_result format="json">\n{"routes":["/later"]}\n</task_result>')

        // A task that depends on the first gets its value whole in the hand-off envelope.
        yield* def.execute(
          { description: "Check routes", prompt: "Check each route.", depends_on: [child!.id], background: false },
          ctx,
        )
        const children = yield* sessions.children(chat.id)
        const dependent = children.find((item) => SubagentLifecycle.read(item)?.title === "Check routes")!
        const handed = text(childPrompts(prompts, dependent.id)[0]!)
        expect(handed).toContain("[vector:peer-data]")
        expect(handed).toContain(
          '\\u003ctask_result format=\\"json\\"\\u003e\\n{\\"routes\\":[\\"/health\\",\\"/\\\\u003cadmin\\\\u003e\\"]}',
        )
        expect(childPrompts(prompts, dependent.id)[0]!.format).toBeUndefined()
      }),
    { trusted: true, config },
  )

  tools.instance(
    "a text finish gets one follow-up, then RunFailed with the last text",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const ops = scripted(
          chat.id,
          prompts,
          [answer({ text: "The routes are /health and /admin.", missed: true }), answer({ text: "Still prose." })],
          sessions,
        )
        const ctx = context({ sessionID: chat.id, messageID: assistant.id, ops, asks: [] })
        const result = yield* def.execute({ ...brief, background: false, output_schema: SCHEMA }, ctx)
        const [child] = yield* sessions.children(chat.id)
        const sent = childPrompts(prompts, child!.id)
        expect(sent).toHaveLength(2)
        expect(text(sent[1]!)).toContain(
          "Your final answer did not match the required JSON Schema: no StructuredOutput call carried it.",
        )
        expect(sent[1]!.format).toMatchObject({ type: "json_schema", schema: SCHEMA })
        expect(result.output).toContain('state="error"')
        expect(result.output).toContain("Structured output did not match output_schema after 1 attempt")
        expect(result.output).toContain("Still prose.")
        expect(result.output).not.toContain('format="json"')
        expect(result.metadata).toMatchObject({ status: "error", structured: { valid: false, attempts: 1 } })
        expect(SubagentLifecycle.read(yield* sessions.get(child!.id))).toMatchObject({
          status: "error",
          structured: { attempts: 1, valid: false },
        })
      }),
    { trusted: true, config },
  )

  tools.instance(
    "attempts are counted exactly: every StructuredOutput call plus every follow-up",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        // Two calls the run answered with errors, then an end without the call; the follow-up's one call matches.
        const ops = scripted(
          chat.id,
          prompts,
          [answer({ calls: 2, missed: true }), answer({ calls: 1, value: { routes: [] } })],
          sessions,
        )
        const ctx = context({ sessionID: chat.id, messageID: assistant.id, ops, asks: [] })
        const result = yield* def.execute({ ...brief, background: false, output_schema: SCHEMA }, ctx)
        expect(result.output).toContain('<task_result format="json">\n{"routes":[]}\n</task_result>')
        expect(result.metadata).toMatchObject({ structured: { valid: true, attempts: 4 } })
        const [child] = yield* sessions.children(chat.id)
        expect(SubagentLifecycle.read(yield* sessions.get(child!.id))?.structured).toMatchObject({
          attempts: 4,
          valid: true,
        })

        // A value the run kept invalid, after its own retries, is not asked for again.
        const kept = scripted(
          chat.id,
          prompts,
          [answer({ calls: 3, value: { routes: [1] }, text: "best effort" })],
          sessions,
        )
        const invalid = yield* def.execute(
          { ...brief, description: "List invalid routes", background: false, output_schema: SCHEMA },
          context({ sessionID: chat.id, messageID: assistant.id, ops: kept, asks: [] }),
        )
        expect(invalid.output).toContain("Structured output did not match output_schema after 3 attempts")
        expect(invalid.output).toContain("best effort")
        expect(invalid.metadata).toMatchObject({ structured: { valid: false, attempts: 3 } })
      }),
    { trusted: true, config },
  )

  tools.instance(
    "a two-run child returns only the last JSON",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const gate = yield* Deferred.make<void>()
        const ops = scripted(
          chat.id,
          prompts,
          [
            () => Deferred.await(gate).pipe(Effect.as({ calls: 1, value: { routes: ["/first"] } })),
            answer({ calls: 1, value: { routes: ["/second"] } }),
          ],
          sessions,
        )
        const ctx = context({ sessionID: chat.id, messageID: assistant.id, ops, asks: [] })
        yield* def.execute({ ...brief, output_schema: SCHEMA }, ctx)
        const [child] = yield* sessions.children(chat.id)
        yield* pollWithTimeout(
          Effect.sync(() => (childPrompts(prompts, child!.id).length === 1 ? true : undefined)),
          "the first run must start",
        )
        // A second run added to the running job, from a resume that names no schema.
        const added = yield* def.execute(
          { description: "List routes", prompt: "Add the admin routes too.", task_id: child!.id },
          ctx,
        )
        expect(added.output).toContain("Message queued for the background task")
        yield* Deferred.succeed(gate, undefined)
        const note = yield* noteFor(prompts, chat.id)
        expect(childPrompts(prompts, child!.id)[1]!.format).toMatchObject({ type: "json_schema", schema: SCHEMA })
        expect(note).toContain('<task_result format="json">\n{"routes":["/second"]}\n</task_result>')
        expect(note).not.toContain("/first")
        expect(note).not.toContain("Report 1 of 2")
      }),
    { trusted: true, config },
  )

  tools.instance(
    "a message that joins a busy structured child settles once: one follow-up, attempts counted once",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const gate = yield* Deferred.make<void>()
        const ended = yield* Deferred.make<SessionV1.WithParts>()
        let runs = 0
        const ops: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
          prompt: (input) =>
            Effect.gen(function* () {
              prompts.push(input)
              if (input.sessionID === chat.id) return { info: assistantOf(input), parts: [] }
              runs += 1
              if (runs === 1) {
                // The child's loop stays busy until the gate opens, then ends in text with no StructuredOutput call.
                yield* status.set(input.sessionID, { type: "busy" })
                yield* Deferred.await(gate)
                const result = yield* write(input, { text: "The routes are /health and /admin.", missed: true })
                yield* status.set(input.sessionID, { type: "idle" })
                yield* Deferred.succeed(ended, result)
                return result
              }
              // The message joined the running loop, so its prompt returns that loop's last answer.
              if (runs === 2) return yield* Deferred.await(ended)
              return yield* write(input, { calls: 1, value: { routes: ["/health", "/admin"] } })
            }).pipe(Effect.provideService(Session.Service, sessions)),
        }
        const ctx = context({ sessionID: chat.id, messageID: assistant.id, ops, asks: [] })
        yield* def.execute({ ...brief, output_schema: SCHEMA }, ctx)
        const [child] = yield* sessions.children(chat.id)
        yield* pollWithTimeout(
          Effect.sync(() => (childPrompts(prompts, child!.id).length === 1 ? true : undefined)),
          "the first run must start",
        )
        const added = yield* def.execute(
          { description: "List routes", prompt: "Include the admin routes.", task_id: child!.id },
          ctx,
        )
        expect(added.output).toContain("added to the running background task's conversation")
        yield* pollWithTimeout(
          Effect.sync(() => (childPrompts(prompts, child!.id).length === 2 ? true : undefined)),
          "the message must join the running loop",
        )
        yield* Deferred.succeed(gate, undefined)
        const note = yield* noteFor(prompts, chat.id)
        const followUps = childPrompts(prompts, child!.id).filter((input) =>
          text(input).includes("Your final answer did not match the required JSON Schema"),
        )
        expect(followUps).toHaveLength(1)
        expect(note).toContain('<task_result format="json">\n{"routes":["/health","/admin"]}\n</task_result>')
        // The follow-up and its one call.
        expect(SubagentLifecycle.read(yield* sessions.get(child!.id))?.structured).toMatchObject({
          attempts: 2,
          valid: true,
        })
      }),
    { trusted: true, config },
  )

  tools.instance(
    "a 9 KiB value returns a ref with no partial JSON",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const value = { routes: Array.from({ length: 950 }, (_, index) => `/r${String(index).padStart(5, "0")}`) }
        expect(JSON.stringify(value).length).toBeGreaterThan(9 * 1024)
        const ops = scripted(chat.id, prompts, [answer({ calls: 1, value })], sessions)
        const ctx = context({ sessionID: chat.id, messageID: assistant.id, ops, asks: [] })
        const result = yield* def.execute({ ...brief, background: false, output_schema: SCHEMA }, ctx)
        const ref = /<task_result format="json" truncated="true" ref="([^"]+)"\/>/.exec(result.output)?.[1]
        expect(ref).toBeDefined()
        expect(result.output).not.toContain("/r00000")
        expect(result.output).not.toContain("{")
        expect(JSON.parse(yield* Effect.promise(() => readFile(ref!, "utf8")))).toEqual(value)
        expect(result.metadata).toMatchObject({ structured: { valid: true, attempts: 1 } })
      }),
    { trusted: true, config },
  )

  tools.instance(
    "a resume re-applies the schema",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const def = yield* (yield* TaskTool).init()
        const prompts: SessionPrompt.PromptInput[] = []
        const ops = scripted(
          chat.id,
          prompts,
          [
            answer({ calls: 1, value: { routes: ["/a"] } }),
            answer({ text: "Added /b.", missed: true }),
            answer({ calls: 1, value: { routes: ["/a", "/b"] } }),
          ],
          sessions,
        )
        const ctx = context({ sessionID: chat.id, messageID: assistant.id, ops, asks: [] })
        yield* def.execute({ ...brief, background: false, output_schema: SCHEMA }, ctx)
        const [child] = yield* sessions.children(chat.id)
        const resumed = yield* def.execute(
          { description: "List routes", prompt: "Add /b.", task_id: child!.id, background: false },
          ctx,
        )
        const sent = childPrompts(prompts, child!.id)
        expect(sent).toHaveLength(3)
        for (const input of sent.slice(1)) expect(input.format).toMatchObject({ type: "json_schema", schema: SCHEMA })
        expect(resumed.output).toContain('<task_result format="json">\n{"routes":["/a","/b"]}\n</task_result>')
        // The resumed run counts its own attempts: one follow-up and one call.
        expect(SubagentLifecycle.read(yield* sessions.get(child!.id))).toMatchObject({
          attempt: 2,
          structured: { schema: SCHEMA, attempts: 2, valid: true },
        })
      }),
    { trusted: true, config },
  )
})

// The real prompt loop against a fake model server: the format reaches the child, whose StructuredOutput tool answers
// an invalid call with an error inside its run, and the parent reads the checked value.

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

const loop = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionStatus.node,
      Question.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      TaskLimits.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, noteQuietMs: 50, noteHoldMs: 300 })],
    ],
  ),
)

const mini = { providerID: lmstudio, modelID: ModelV2.ID.make("mini") }

function loopConfig(url: string): Partial<ConfigV1.Info> {
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
          mini: {
            id: "mini",
            name: "Mini",
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
        options: { apiKey: "test-key", baseURL: url, concurrency: 64 },
      },
    },
  }
}

const BRIEF = "ROUTES_BRIEF: list the HTTP routes and answer with them"
const isChild = (hit: { body: Record<string, unknown> }) =>
  Array.isArray(hit.body.messages) &&
  hit.body.messages.some(
    (message) => isRecord(message) && message.role === "user" && JSON.stringify(message.content).includes(BRIEF),
  )
const isTitle = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

describe("task output_schema in the run loop", () => {
  loop.instance(
    "the child's own StructuredOutput retry counts, and the parent reads checked JSON",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "vector.json")
        yield* fs.writeWithDirs(file, JSON.stringify(loopConfig(llm.url)))
        const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
        yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Routes" })
        yield* llm.pushMatch(
          (hit) => !isChild(hit) && !isTitle(hit.body),
          reply().tool("task", {
            description: "List routes",
            prompt: BRIEF,
            subagent_type: "general",
            background: false,
            output_schema: SCHEMA,
          }),
          reply().text("Listed the routes.").stop(),
        )
        yield* llm.pushMatch(
          isChild,
          reply().tool("StructuredOutput", { routes: "/health" }),
          reply().tool("StructuredOutput", { routes: ["/health"] }),
        )
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: mini,
          parts: [{ type: "text", text: "list the HTTP routes the server registers" }],
        })
        const [child] = yield* sessions.children(chat.id)
        const childHits = (yield* llm.hits).filter(isChild)
        expect(childHits).toHaveLength(2)
        // The child was offered the tool, and its invalid call was answered with the problem.
        expect(JSON.stringify(childHits[0]!.body.tools)).toContain("StructuredOutput")
        expect(JSON.stringify(childHits[1]!.body.messages)).toContain("Invalid structured output")
        expect(SubagentLifecycle.read(child!)?.structured).toMatchObject({ attempts: 2, valid: true })
        const parent = yield* sessions.messages({ sessionID: chat.id })
        const call = parent
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "task")
        expect(call?.type === "tool" && call.state.status === "completed" ? call.state.output : "").toContain(
          '<task_result format="json">\n{"routes":["/health"]}\n</task_result>',
        )
      }),
    { git: true },
    90_000,
  )
})
