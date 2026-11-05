import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Global } from "@vectordevai/core/global"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Database } from "@vectordevai/core/database/database"
import { EventTable } from "@vectordevai/core/event/sql"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { EventV2Bridge } from "@/event-v2-bridge"
import { eq } from "drizzle-orm"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

// What a request costs by its size, measured against a fake model server: how many requests it makes, which tools it
// offers and which reasoning effort it sends. No paid model is called.

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
      SessionPrompt.node,
      Session.node,
      Question.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      SpendGuard.node,
      EventV2Bridge.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    ],
  ),
)

// A model that can reason or not, like the free North Mini Code: its efforts are "none" and "high".
const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("north-mini-code") }

// A model whose provider caches the prompt prefix behind breakpoints, as Claude does.
const cached = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("claude-test") }

// North Mini Code with a small context, so one large step compacts the history.
const small = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("tiny-context") }

function providerConfig(url: string, extra: Partial<ConfigV1.Info> = {}): Partial<ConfigV1.Info> {
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
          "north-mini-code": {
            id: "cohere/north-mini-code",
            name: "North Mini Code",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
          "tiny-context": {
            id: "tiny-context",
            name: "Tiny Context",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 20_000, output: 2_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
          "claude-test": {
            id: "claude-test",
            name: "Claude Test",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
    ...extra,
  }
}

const setup = Effect.fn("test.setup")(function* (extra: Partial<ConfigV1.Info> = {}) {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  const file = path.join(directory, "vector.json")
  yield* fs.writeWithDirs(file, JSON.stringify(providerConfig(llm.url, extra)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  return {
    directory,
    llm,
    fs,
    prompt: yield* SessionPrompt.Service,
    sessions: yield* Session.Service,
  }
})

const isTitle = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

function toolNames(body: Record<string, unknown> | undefined) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools
    .map((item) =>
      item && typeof item === "object" && "function" in item ? (item.function as { name: string }).name : "",
    )
    .toSorted()
}

function systemText(body: Record<string, unknown> | undefined) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages
    .filter((message) => message && typeof message === "object" && "role" in message && message.role === "system")
    .map((message) => String((message as { content: unknown }).content))
    .join("\n")
}

const send = (prompt: SessionPrompt.Interface, sessionID: SessionID, text: string, extra = {}) =>
  prompt.prompt({ sessionID, agent: "build", model: ref, parts: [{ type: "text", text }], ...extra })

const conversation = (body: Record<string, unknown> | undefined) =>
  ((body?.messages ?? []) as { role: string }[]).filter((message) => message.role !== "system")

// The judge's own request: the subagent's system prompt names it.
const isJudge = (body: Record<string, unknown>) => systemText(body).includes("independent completion judge")

// Large work, as the user asks for it: Thorough comes only from the user's ask, escalate or a continuation of it.
const LARGE = "be thorough: migrate the app to the new router across 40 files"
// A request of its own after finished work: too long to read as a follow-up.
const UNRELATED = "add a settings page with a dark mode toggle, tests for the parser and a new billing flow"

// The tools every Work request is offered: the normal set without subagents.
const WORK = ["bash", "edit", "escalate", "glob", "grep", "question", "read", "todowrite", "write"]

// The quick lane's one tool: escalate, which hands a message it misread as social to the full agent.
const QUICK = ["escalate"]

// Whether a request is offered the Work tools rather than the quick lane's escalate alone.
const working = (body: Record<string, unknown> | undefined) => toolNames(body).includes("read")

const judgeRequests = (bodies: Record<string, unknown>[]) => bodies.filter(isJudge).length

// A turn of the shared conversation where the agent asks through the question tool and the user dismisses it.
const DISMISSED = "(dismissed question)"

const judgeVerdicts = (messages: SessionV1.WithParts[]) =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "tool" && part.metadata?.judge ? [part.metadata.judge] : [])),
  )

describe("task sizing", () => {
  it.instance(
    "hi is one direct request: no tools, no title request, no reasoning, no subagents or judge",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({})
        yield* llm.text("Hi! What would you like to work on?")

        // The judge is on, and a greeting still never brings it in.
        const result = yield* send(prompt, chat.id, "hi", { judge: "changes" })
        yield* prompt.awaitTitles()

        const bodies = yield* llm.inputs
        expect(bodies).toHaveLength(1)
        const [body] = bodies
        // One small tool, escalate, so a message misread as social can still go on as Work.
        expect(toolNames(body)).toEqual(QUICK)
        expect(body?.reasoning_effort).toBe("none")
        // The quick lane: the newest message only, no repository context.
        expect(conversation(body)).toHaveLength(1)
        // 515 characters before the lane offered escalate; about 1,000 with it.
        expect(JSON.stringify(body).length).toBeLessThan(1_100)
        expect(systemText(body)).not.toContain("<env>")
        expect(systemText(body)).not.toContain("subagent")
        expect(result.info.role === "assistant" && result.info.size).toBe("chat")
        // The first line is the title, with no model request for it.
        expect((yield* sessions.get(chat.id)).title).toBe("hi")
        expect((yield* sessions.children(chat.id)).length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "thanks, thanks that works and other social messages each cost one bare request",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const texts = [
          "thanks",
          "thanks, that works",
          "thanks for the fix!",
          "hii",
          "hey vector",
          "what can you do?",
          "who made vector?",
        ]
        for (const text of texts) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Glad to help!")
          yield* send(prompt, chat.id, text)
        }
        const bodies = yield* llm.inputs
        expect(bodies).toHaveLength(texts.length)
        for (const [index, body] of bodies.entries()) {
          expect(toolNames(body), texts[index]).toEqual(QUICK)
          expect(body?.reasoning_effort, texts[index]).toBe("none")
          expect(conversation(body), texts[index]).toHaveLength(1)
        }
      }),
    { git: true },
  )

  it.instance(
    "the quick lane offers escalate alone, and a message it misread goes on as Work with the tools and history",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("The preview is up at https://preview.vercel.app. Ready for production when you are.")
        yield* send(prompt, chat.id, "deploy a preview to vercel")
        const before = (yield* llm.inputs).length
        // "perfect" reads as social, but here it means "go ahead": the quick lane hands it on.
        yield* llm.tool("escalate", { reason: "the user wants the production deploy" })
        yield* llm.tool("write", { filePath: path.join(directory, "vercel.json"), content: "{}\n" })
        yield* llm.text("Deployed to production.")
        const result = yield* send(prompt, chat.id, "perfect")
        const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(3)
        // The quick lane: escalate alone, reasoning off, this message and the agent's previous reply only.
        expect(toolNames(bodies[0])).toEqual(QUICK)
        expect(bodies[0]?.reasoning_effort).toBe("none")
        expect(conversation(bodies[0])).toHaveLength(1)
        expect(systemText(bodies[0])).toContain("Ready for production when you are.")
        expect(JSON.stringify(bodies[0]?.messages)).not.toContain("deploy a preview to vercel")
        // The same request goes on as Work: every Work tool, the provider's effort and the whole conversation.
        for (const body of bodies.slice(1)) {
          expect(toolNames(body)).toEqual(expect.arrayContaining(WORK))
          expect(toolNames(body)).not.toContain("task")
          expect(body?.reasoning_effort).toBeUndefined()
          expect(JSON.stringify(body?.messages)).toContain("deploy a preview to vercel")
        }
        expect(result.info.role === "assistant" && result.info).toMatchObject({ size: "standard", agent: "build" })
        // Work is not judged in "Large tasks" mode.
        expect((yield* sessions.children(chat.id)).length).toBe(0)
        const output = (yield* MessageV2.filterCompactedEffect(chat.id)).flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool" && part.tool === "escalate" && part.state.status === "completed"
              ? [part.state.output]
              : [],
          ),
        )
        expect(output[0]).toContain("now Work")
      }),
    { git: true },
  )

  it.instance(
    "an app's own quick-lane message can escalate too, while a Quick mode pick stays on the quick lane",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const lane = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("escalate", { reason: "the user asked for a deploy" })
        yield* llm.text("Deployed.")
        const result = yield* send(prompt, lane.id, "thanks", { agent: "quick" })
        const picked = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("parseArgs reads the flags.")
        yield* send(prompt, picked.id, "what does parseArgs do?", { agent: "quick", size: "chat" })
        const [quick, work, chosen] = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(toolNames(quick)).toEqual(QUICK)
        expect(toolNames(work)).toEqual(expect.arrayContaining(WORK))
        expect(result.info.role === "assistant" && result.info).toMatchObject({ size: "standard", agent: "build" })
        // The person picked Quick mode: no tools, nothing to escalate.
        expect(toolNames(chosen)).toEqual([])
        expect(chosen?.reasoning_effort).toBe("none")
      }),
    { git: true },
  )

  it.instance(
    "a thanks with a request after it and no comma is Work with the history, never the quick lane",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        for (const text of [
          "thanks for the update ship it to vercel",
          "thanks for the fix ship it",
          "thanks for that run the tests",
          "thanks for the fix what about tests?",
        ]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.tool("write", { filePath: path.join(directory, "README.md"), content: "# fixed\n" })
          yield* llm.text("Fixed the typo in README.md.")
          yield* send(prompt, chat.id, "fix the typo in README.md")
          const before = (yield* llm.inputs).length
          yield* llm.text("On it.")
          const result = yield* send(prompt, chat.id, text)
          const [body] = (yield* llm.inputs).slice(before).filter((item) => !isTitle(item))
          expect(toolNames(body), text).toEqual(expect.arrayContaining(WORK))
          expect(body?.reasoning_effort, text).toBeUndefined()
          expect(JSON.stringify(body?.messages), text).toContain("fix the typo in README.md")
          expect(result.info.role === "assistant" && result.info, text).toMatchObject({ size: "standard", agent: "build" })
        }
      }),
    { git: true },
  )

  it.instance(
    "ship to vercel and other small actions get the normal tools at the provider's default effort, and no judge",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const asks = ["ship to vercel", "fix the typo in README.md", "keep it simple, fix the typo in README.md"]
        for (const text of asks) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.tool("write", { filePath: path.join(directory, "README.md"), content: "# The repository\n" })
          yield* llm.text("Done.")
          const result = yield* send(prompt, chat.id, text)
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
          expect((yield* sessions.children(chat.id)).length, text).toBe(0)
        }
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(asks.length * 2)
        for (const body of bodies) {
          const tools = toolNames(body)
          expect(tools).toEqual(expect.arrayContaining(WORK))
          expect(tools).not.toContain("task")
          expect(tools).not.toContain("task_manage")
          // Never reasoning off and never forced low: the provider's own default.
          expect(body?.reasoning_effort).toBeUndefined()
          expect(systemText(body)).toContain("<completion_policy>")
          expect(systemText(body)).toContain("No subagents are available")
          expect(JSON.stringify(body?.messages)).toContain("Standard request")
        }
      }),
    { git: true },
  )

  it.instance(
    "switch the codebase to Go gets the normal tools at the provider's default effort, and escalate takes it to Thorough",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("escalate", { reason: "every package needs porting" })
        yield* llm.text("Here is the port plan.")

        const result = yield* send(prompt, chat.id, "switch the codebase to Go")

        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(2)
        expect(toolNames(bodies[0])).toEqual(expect.arrayContaining(WORK))
        expect(toolNames(bodies[0])).not.toContain("task")
        expect(bodies[0]?.reasoning_effort).toBeUndefined()
        // Thorough from the next step: subagents and high effort, and nothing left to raise to.
        expect(toolNames(bodies[1])).toEqual(expect.arrayContaining(["task", "task_manage", "todowrite", "question"]))
        expect(toolNames(bodies[1])).not.toContain("escalate")
        expect(bodies[1]?.reasoning_effort).toBe("high")
        expect(result.info.role === "assistant" && result.info.size).toBe("thorough")
        const messages = yield* MessageV2.filterCompactedEffect(chat.id)
        const output = messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool" && part.tool === "escalate" && part.state.status === "completed"
              ? [part.state.output]
              : [],
          ),
        )[0]
        expect(output).toContain("now Thorough")
        // The Standard note stays as it was for the cache, and the result says it no longer applies.
        expect(output).toContain("replaces the size note")
      }),
    { git: true },
  )

  it.instance(
    "be thorough reaches Thorough: subagents, the to-do list and high effort; the same work unasked is Work",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        for (const text of [LARGE, "migrate the app to the new router across 40 files"]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Here is the migration plan.")
          yield* send(prompt, chat.id, text)
        }
        const [asked, unasked] = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(toolNames(asked)).toEqual(expect.arrayContaining(["task", "task_manage", "todowrite", "question", "edit"]))
        expect(toolNames(asked)).not.toContain("escalate")
        expect(asked?.reasoning_effort).toBe("high")
        expect(systemText(asked)).toContain("<subagent_policy>")
        expect(systemText(asked)).toContain("<completion_policy>")
        expect(JSON.stringify(asked?.messages)).toContain("Thorough request")
        // No word about scope sizes it: the agent escalates once it sees the work.
        expect(toolNames(unasked)).toEqual(expect.arrayContaining(WORK))
        expect(toolNames(unasked)).not.toContain("task")
        expect(unasked?.reasoning_effort).toBeUndefined()
      }),
    { git: true },
  )

  it.instance(
    "questions, reviews and debugging are Work at the provider's own effort, style words included",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const asks = [
          "what does the classify function in task-size.ts do?",
          "review this codebase for security issues",
          "why does this deadlock?",
          "quick question: why does this deadlock?",
          "don't overthink it, fix the race condition in the scheduler",
        ]
        for (const text of asks) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Here is what I found.")
          const result = yield* send(prompt, chat.id, text)
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
        }
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(asks.length)
        for (const [index, body] of bodies.entries()) {
          expect(toolNames(body), asks[index]).toEqual(expect.arrayContaining(WORK))
          expect(toolNames(body), asks[index]).not.toContain("task")
          expect(body?.reasoning_effort, asks[index]).toBeUndefined()
        }
      }),
    { git: true },
  )

  it.instance(
    "a mention of subagents or the judge is not an ask for them, so the judge stays off with its setting",
    () =>
      Effect.gen(function* () {
        // The judge setting is off: only an ask in the message ("run the judge") would turn it on.
        const { llm, prompt, sessions, directory } = yield* setup()
        for (const text of [
          "fix the bug with subagents not starting",
          "llm as a judge launches on hi, fix it",
          // Requests about the judge and subagents themselves, which this repository builds.
          "use the judge only for large tasks",
          "run the judge tests",
          "use subagents in background mode by default",
        ]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.tool("write", { filePath: path.join(directory, "fix.ts"), content: "export {}\n" })
          yield* llm.text("Fixed.")
          const result = yield* send(prompt, chat.id, text)
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
          expect((yield* sessions.children(chat.id)).length, text).toBe(0)
        }
        for (const body of (yield* llm.inputs).filter((body) => !isTitle(body))) {
          expect(toolNames(body)).not.toContain("task")
          expect(body?.reasoning_effort).toBeUndefined()
        }
      }),
    { git: true },
  )

  it.instance(
    "telling Vector to run the judge runs it, even with the setting off",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated the router.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, chat.id, "migrate the router, then run the judge")
        expect((yield* llm.inputs).filter(isJudge)).toHaveLength(1)
        expect((yield* sessions.children(chat.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "the V1 runner sizes a conversation the way V2 does: social messages bare, everything else with tools",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        // The same conversation, with the same replies, as "sizes the same conversation as the V1 runner" in the core
        // package's session-runner test: true where the turn is offered tools. Thorough adds subagents here.
        const conversation = [
          ["hi", "Hi! How can I help you today?", false, "chat"],
          ["ship to vercel", "Deployed. Do you want me to keep the preview URL?", true, "standard"],
          // A "no" answers the agent's question, so it is never a bare reply.
          ["no", "Removed the preview URL.", true, "standard"],
          ["thanks, that works", "You're welcome!", false, "chat"],
          ["be thorough: port the TUI to Rust", "Here is the plan in three phases. Shall I start?", true, "thorough"],
          ["build the app", "Ported the renderer. Should I go on with the input layer?", true, "thorough"],
          // A thanks while the agent waits on an answer follows up that work.
          ["thanks", "Going on with the input layer.", true, "thorough"],
          ["continue", "Ported every screen. Let me know if this works for you.", true, "thorough"],
          // Thorough ends with its run: a closing line asks nothing, so a thanks is bare and a new request is Work.
          ["thanks!", "Anytime!", false, "chat"],
          ["fix the typo in README", "Fixed the typo.", true, "standard"],
          // A greeting's reply that asks back waits on nothing, so the small talk that answers it stays bare.
          ["hey, how are you?", "I'm doing great, thanks for asking! How about you?", false, "chat"],
          ["great, thanks!", "Glad to hear it!", false, "chat"],
          // The agent asks through the question tool and the user dismisses it: the thanks after it follows up.
          ["which router should I use?", DISMISSED, true, "standard"],
          ["thanks", "Going with the new router.", true, "standard"],
        ] as const
        const question = yield* Question.Service
        for (const [text, answer, tools, size] of conversation) {
          const before = (yield* llm.inputs).length
          if (answer !== DISMISSED) yield* llm.text(answer)
          if (answer === DISMISSED)
            yield* llm.tool("question", {
              questions: [{ question: "Which router?", header: "Router", options: [{ label: "v6", description: "New" }] }],
            })
          const running = yield* send(prompt, chat.id, text).pipe(Effect.forkChild)
          if (answer === DISMISSED) {
            let pending = yield* question.list()
            while (pending.length === 0) {
              yield* Effect.sleep("10 millis")
              pending = yield* question.list()
            }
            yield* question.reject(pending[0]!.id)
          }
          const result = yield* Fiber.join(running)
          const [body] = (yield* llm.inputs).slice(before)
          expect(working(body), text).toBe(tools)
          // Chat is the quick lane with escalate alone.
          if (!tools) expect(toolNames(body), text).toEqual(QUICK)
          expect(result.info.role === "assistant" && result.info.size, text).toBe(size)
          expect(toolNames(body).includes("task"), text).toBe(size === "thorough")
        }
      }),
    { git: true },
  )

  it.instance(
    "a yes to the agent's question continues the request it answers",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("I can publish a preview. Shall I deploy?")
        yield* send(prompt, chat.id, "ship to vercel")
        yield* llm.text("Published.")
        yield* send(prompt, chat.id, "yes")
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(2)
        // Not the history-free quick lane: the answer goes on with the work's tools and history.
        expect(toolNames(bodies[1])).toEqual(expect.arrayContaining(WORK))
        expect(JSON.stringify(bodies[1]?.messages)).toContain("ship to vercel")
      }),
    { git: true },
  )

  it.instance(
    "a sure to an offer without a question mark is Work with the history: the Thorough run ended",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Migrated the router. I can also add tests for this if you want.")
        yield* send(prompt, chat.id, LARGE)
        yield* llm.text("Added the tests.")
        const result = yield* send(prompt, chat.id, "sure")
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(2)
        expect(toolNames(bodies[1])).toEqual(expect.arrayContaining(WORK))
        expect(toolNames(bodies[1])).not.toContain("task")
        expect(JSON.stringify(bodies[1]?.messages)).toContain("I can also add tests for this if you want.")
        expect(result.info.role === "assistant" && result.info.size).toBe("standard")
      }),
    { git: true },
  )

  it.instance(
    "Vector runs the judge itself after a thorough run that changed files",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        const target = path.join(directory, "router.ts")
        yield* llm.tool("write", { filePath: target, content: "export const router = 1\n" })
        yield* llm.text("Migrated the router.")
        // The judge subagent's own request.
        yield* llm.push(
          reply().text("Checked the diff.\n\nVERDICT: PASS\nSCORES: requirement 4/4, correctness 4/4").stop(),
        )

        yield* send(prompt, chat.id, "be thorough: migrate the app to the new router", { judge: "thorough" })

        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        // Two requests for the work and one for the judge; no request asks the model to launch a judge.
        expect(bodies).toHaveLength(3)
        expect(systemText(bodies[2])).toContain("independent completion judge")
        for (const body of bodies.slice(0, 2))
          expect(JSON.stringify(body?.messages)).not.toContain("<vector_verified_completion>")
        expect(judgeVerdicts(yield* MessageV2.filterCompactedEffect(chat.id))).toEqual([
          { round: 1, size: "thorough", verdict: "PASS" },
        ])
      }),
    { git: true },
  )

  it.instance(
    "a judge FAIL goes back for repair, and the judge looks again",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        const target = path.join(directory, "router.ts")
        yield* llm.tool("write", { filePath: target, content: "export const router = 1\n" })
        yield* llm.text("Migrated the router.")
        yield* llm.text("VERDICT: FAIL\nBLOCKERS:\n- router.ts exports a number")
        yield* llm.tool("write", { filePath: target, content: "export const router = () => {}\n" })
        yield* llm.text("Repaired the export.")
        yield* llm.text("VERDICT: PASS")

        yield* send(prompt, chat.id, "be thorough: migrate the app to the new router", { judge: "thorough" })

        expect(judgeVerdicts(yield* MessageV2.filterCompactedEffect(chat.id))).toEqual([
          { round: 1, size: "thorough", verdict: "FAIL" },
          { round: 2, size: "thorough", verdict: "PASS" },
        ])
        expect((yield* llm.inputs).filter((body) => !isTitle(body))).toHaveLength(6)
      }),
    { git: true },
  )

  it.instance(
    "legacy accounting conserves priced root and automatic judge repair attempts without replay inflation",
    () =>
      Effect.gen(function* () {
        const fake = yield* TestLLMServer
        const base = providerConfig(fake.url).provider!.lmstudio!
        const selected = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("accounting-judge") }
        const { llm, prompt, sessions, directory } = yield* setup({
          provider: {
            lmstudio: {
              ...base,
              models: {
                "accounting-judge": {
                  ...base.models!["north-mini-code"],
                  id: "accounting-judge",
                  cost: { input: 2, output: 10 },
                },
              },
            },
          },
        })
        const guard = yield* SpendGuard.Service
        const database = yield* Database.Service
        const events = yield* EventV2Bridge.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        const target = path.join(directory, "accounting-router.ts")
        yield* llm.push(
          reply()
            .tool("write", { filePath: target, content: "export const router = 1\n" })
            .usage({ input: 1_000, output: 100 }),
          reply().text("Migrated the router.").usage({ input: 2_000, output: 200 }).stop(),
          reply()
            .text("VERDICT: FAIL\nBLOCKERS:\n- router exports a number")
            .usage({ input: 3_000, output: 300 })
            .stop(),
          reply()
            .tool("write", { filePath: target, content: "export const router = () => {}\n" })
            .usage({ input: 4_000, output: 400 }),
          reply().text("Repaired the export.").usage({ input: 5_000, output: 500 }).stop(),
          reply().text("VERDICT: PASS").usage({ input: 6_000, output: 600 }).stop(),
        )
        yield* send(prompt, chat.id, "be thorough: migrate the router and verify the repair", {
          model: selected,
          judge: "thorough",
          budget: { usd: 1 },
        })
        const children = yield* sessions.children(chat.id)
        const root = yield* sessions.get(chat.id)
        // At $2/M input and $10/M output: root attempts 1,2,4,5 cost $0.036; judge attempts 3,6 cost $0.027.
        expect(root.cost).toBeCloseTo(0.036, 9)
        expect(root.subagentCost).toBeCloseTo(0.027, 9)
        expect(root.tokens).toMatchObject({ input: 12_000, output: 1_200, reasoning: 0, cache: { read: 0, write: 0 } })
        expect(root.subagentTokens).toEqual({ input: 9_000, output: 900, reasoning: 0, cache: { read: 0, write: 0 } })
        expect(children).toHaveLength(2)
        expect(children.map((child) => child.cost).toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0.009, 0.018])
        expect(children.every((child) => child.metadata?.subagent?.agent === "judge")).toBe(true)
        expect(judgeVerdicts(yield* MessageV2.filterCompactedEffect(chat.id))).toEqual([
          { round: 1, size: "thorough", verdict: "FAIL" },
          { round: 2, size: "thorough", verdict: "PASS" },
        ])
        expect((yield* guard.snapshot(chat.id))?.spentUsd).toBeCloseTo(0.063, 9)
        expect((yield* guard.snapshot(chat.id))?.steps).toBe(6)
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(6)
        expect(bodies.every((body) => body.model === "accounting-judge")).toBe(true)
        const recorded = yield* database.db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, children[0].id))
          .all()
        const settlement = recorded.find(
          (event) =>
            event.type.startsWith(`${SessionV1.Event.PartUpdated.type}.`) &&
            (event.data as { part?: { type?: string } }).part?.type === "step-finish",
        )
        if (!settlement) return yield* Effect.die("Missing real judge settlement")
        yield* events.replay({
          id: settlement.id,
          aggregateID: settlement.aggregate_id,
          seq: settlement.seq,
          type: settlement.type,
          data: settlement.data,
        })
        expect((yield* sessions.get(chat.id)).subagentCost).toBeCloseTo(0.027, 9)
        expect((yield* guard.snapshot(chat.id))?.spentUsd).toBeCloseTo(0.063, 9)
        expect((yield* guard.snapshot(chat.id))?.steps).toBe(6)
        expect(yield* llm.calls).toBe(6)
      }),
    { git: true },
  )

  it.instance(
    "the judge never checks Work in its 'thorough' mode, and checks every change in its 'changes' mode",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const first = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "a.txt"), content: "a\n" })
        yield* llm.text("Wrote a.txt.")
        yield* send(prompt, first.id, "write a.txt", { judge: "thorough" })
        expect((yield* sessions.children(first.id)).length).toBe(0)

        const second = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "b.txt"), content: "b\n" })
        yield* llm.text("Wrote b.txt.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, second.id, "write b.txt", { judge: "changes" })
        expect((yield* sessions.children(second.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "an older client's hidden judge policy turns the judge on and never reaches the model",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const policy = "<vector_verified_completion>LLM-as-a-judge is enabled. Then delegate to the judge subagent."
        const legacy = (text: string) => [
          { type: "text" as const, text },
          { type: "text" as const, text: policy, synthetic: true },
        ]
        const greeting = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Hello!")
        yield* prompt.prompt({ sessionID: greeting.id, agent: "build", model: ref, parts: legacy("hi") })
        const [hello] = yield* llm.inputs
        expect(toolNames(hello)).toEqual(QUICK)
        expect(JSON.stringify(hello)).not.toContain("vector_verified_completion")

        const work = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated.")
        yield* llm.text("VERDICT: PASS")
        yield* prompt.prompt({ sessionID: work.id, agent: "build", model: ref, parts: legacy(LARGE) })
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        for (const body of bodies) expect(JSON.stringify(body)).not.toContain("delegate to the judge subagent")
        expect((yield* sessions.children(work.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "on a caching provider a Work follow-up keeps the cached tools, but cannot launch a subagent",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Plan ready.")
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", model: cached, parts: [{ type: "text", text: LARGE }] })
        yield* llm.tool("task", { description: "add it", prompt: "add the settings page", subagent_type: "general" })
        yield* llm.text("Added it myself.")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: cached,
          parts: [{ type: "text", text: UNRELATED }],
        })
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(3)
        // The same tool definitions as the cached prefix, so the provider reads it instead of writing a new one.
        expect(toolNames(bodies[1])).toEqual(toolNames(bodies[0]))
        expect((yield* sessions.children(chat.id)).length).toBe(0)
        const messages = yield* MessageV2.filterCompactedEffect(chat.id)
        const refused = messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool" && part.tool === "task" && part.state.status === "error" ? [part.state.error] : [],
          ),
        )
        expect(refused[0]).toContain("Subagents are not offered for this request")
      }),
    { git: true },
  )

  it.instance(
    "a thorough judged run that compacts is still judged, and a continue afterwards keeps tools and history",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        // The write step fills the small context, so Vector compacts before the next step.
        yield* llm.push(
          reply()
            .tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
            .usage({ input: 19_000, output: 100 }),
        )
        yield* llm.text("Summary of the work so far.")
        yield* llm.text("Migrated the router.")
        yield* llm.text("VERDICT: PASS")
        yield* prompt.prompt({ sessionID: chat.id, agent: "build", model: small, parts: [{ type: "text", text: LARGE }] })

        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(4)
        // After the summary the request is still Thorough: its tools, its effort and its note.
        expect(toolNames(bodies[2])).toEqual(expect.arrayContaining(["task", "todowrite"]))
        expect(bodies[2]?.reasoning_effort).toBe("high")
        expect(JSON.stringify(bodies[2]?.messages)).toContain("Thorough request")
        // And it is judged, on the user's own words and the file the summarised step wrote.
        expect(isJudge(bodies[3]!)).toBe(true)
        expect(JSON.stringify(bodies[3]?.messages)).toContain("new router across 40 files")
        expect(JSON.stringify(bodies[3]?.messages)).toContain("router.ts")
        expect((yield* sessions.children(chat.id)).length).toBe(1)

        yield* llm.text("All routes are migrated.")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: small,
          parts: [{ type: "text", text: "continue" }],
        })
        const after = (yield* llm.inputs).filter((body) => !isTitle(body)).at(-1)
        // Not the quick lane: the work's tools and the history, summary included.
        expect(toolNames(after)).toEqual(expect.arrayContaining(["read", "task"]))
        expect(conversation(after).length).toBeGreaterThan(1)
        expect(JSON.stringify(after?.messages)).toContain("Summary of the work so far.")
      }),
    { git: true },
  )

  it.instance(
    "a message sent during a thorough run's final step does not leave the thorough work unjudged",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        const { promise: gate, resolve: release } = Promise.withResolvers<void>()
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.hold("Migrated the router.", gate)
        yield* llm.text("Fixed the typo.")
        yield* llm.text("VERDICT: PASS")

        const first = yield* send(prompt, chat.id, LARGE).pipe(Effect.forkChild)
        yield* llm.wait(2)
        const second = yield* send(prompt, chat.id, "also fix the typo in README").pipe(Effect.forkChild)
        yield* Effect.sleep("300 millis")
        release()
        yield* Fiber.join(first)
        yield* Fiber.join(second)

        const judged = (yield* llm.inputs).filter(isJudge)
        expect(judged).toHaveLength(1)
        expect(JSON.stringify(judged[0]?.messages)).toContain("new router across 40 files")
        expect(JSON.stringify(judged[0]?.messages)).toContain("router.ts")
        expect((yield* sessions.children(chat.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "the judge skips a run that ended asking a question, and a yes takes the work to the judge",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated 30 routes. Should I also migrate the tests?")
        yield* send(prompt, chat.id, LARGE)
        // No judge, and no repair that would carry on without the user's answer.
        expect((yield* sessions.children(chat.id)).length).toBe(0)
        expect((yield* llm.inputs).filter((body) => !isTitle(body))).toHaveLength(2)

        yield* llm.tool("write", { filePath: path.join(directory, "router.test.ts"), content: "test()\n" })
        yield* llm.text("Migrated the tests.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, chat.id, "yes")
        const judged = (yield* llm.inputs).filter(isJudge)
        expect(judged).toHaveLength(1)
        expect(JSON.stringify(judged[0]?.messages)).toContain("router.ts")
        expect(JSON.stringify(judged[0]?.messages)).toContain("router.test.ts")
      }),
    { git: true },
  )

  it.instance(
    "a thorough plan that asks a question keeps its size, subagents and judge when the user answers in a sentence",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const answers = ["yes, start with phase 1", "proceed with all phases", "option 2", "continue where you left off"]
        for (const answer of answers) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Here is the plan in three phases. Should I start with phase 1?")
          yield* send(prompt, chat.id, LARGE)
          const before = (yield* llm.inputs).length
          yield* llm.tool("write", { filePath: path.join(directory, "r.ts"), content: "export {}\n" })
          yield* llm.text("Phase 1 is done.")
          yield* llm.text("VERDICT: PASS")
          const result = yield* send(prompt, chat.id, answer)
          const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
          // The implementation runs with the plan's harness: subagents, the to-do list and high effort.
          expect(toolNames(bodies[0]), answer).toEqual(expect.arrayContaining(["task", "task_manage", "todowrite"]))
          expect(bodies[0]?.reasoning_effort, answer).toBe("high")
          expect(JSON.stringify(bodies[0]?.messages), answer).toContain("new router across 40 files")
          expect(result.info.role === "assistant" && result.info.size, answer).toBe("thorough")
          // And the judge checks it.
          const judged = bodies.filter(isJudge)
          expect(judged, answer).toHaveLength(1)
          expect(JSON.stringify(judged[0]?.messages), answer).toContain("r.ts")
          expect((yield* sessions.children(chat.id)).length, answer).toBe(1)
        }
      }),
    { git: true },
  )

  it.instance(
    "a no thanks or a thanks to a judged large task's offer answers it at the work's size, and the judge follows",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const offer = "Migrated all 40 routes and the tests pass. Want me to also update the docs?"

        // The work waits on the user, so the decline goes on with the work's tools and history, never the quick lane.
        // The judge reads the offer and the decline, and the work's own report.
        const declined = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text(offer)
        yield* send(prompt, declined.id, LARGE)
        expect((yield* sessions.children(declined.id)).length).toBe(0)
        const start = (yield* llm.inputs).length
        yield* llm.text("Okay, I will leave the docs.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, declined.id, "no thanks")
        const replies = (yield* llm.inputs).slice(start).filter((body) => !isTitle(body))
        expect(replies).toHaveLength(2)
        expect(toolNames(replies[0])).toEqual(expect.arrayContaining(["task", "todowrite"]))
        expect(JSON.stringify(replies[0]?.messages)).toContain("new router across 40 files")
        expect(isJudge(replies[1]!)).toBe(true)
        const declinedBrief = JSON.stringify(replies[1]?.messages)
        expect(declinedBrief).toContain("Want me to also update the docs?")
        expect(declinedBrief).toContain("no thanks")
        expect(declinedBrief).toContain("out of scope")
        expect(declinedBrief).toContain("Migrated all 40 routes and the tests pass")
        expect((yield* sessions.children(declined.id)).length).toBe(1)

        // A thanks to the offer answers it too. The judge checks the work, and a FAIL is repaired with its tools.
        const thanked = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export const a = 1\n" })
        yield* llm.text(offer)
        yield* send(prompt, thanked.id, LARGE)
        const before = (yield* llm.inputs).length
        yield* llm.text("You're welcome!")
        yield* llm.text("VERDICT: FAIL\nBLOCKERS:\n- router.ts exports a number")
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export const a = () => {}\n" })
        yield* llm.text("Repaired the export.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, thanked.id, "thanks")
        const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
        expect(toolNames(bodies[0])).toEqual(expect.arrayContaining(["task", "todowrite"]))
        expect(isJudge(bodies[1]!)).toBe(true)
        expect(JSON.stringify(bodies[1]?.messages)).toContain("new router across 40 files")
        expect(JSON.stringify(bodies[1]?.messages)).toContain("router.ts")
        expect(toolNames(bodies[2])).toEqual(expect.arrayContaining(["write", "task", "todowrite"]))
        expect(bodies[2]?.reasoning_effort).toBe("high")
        expect(bodies.filter(isJudge)).toHaveLength(2)
        expect((yield* sessions.children(thanked.id)).length).toBe(2)
      }),
    { git: true },
  )

  it.instance(
    "a thanks the app sends on its quick lane after a large task's question answers it, and the judge follows",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export const a = 1\n" })
        yield* llm.text("Migrated all 40 routes and the tests pass. Want me to also update the docs?")
        yield* send(prompt, chat.id, LARGE)
        expect((yield* sessions.children(chat.id)).length).toBe(0)
        const before = (yield* llm.inputs).length
        yield* llm.text("You're welcome!")
        yield* llm.text("VERDICT: FAIL\nBLOCKERS:\n- router.ts exports a number")
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export const a = () => {}\n" })
        yield* llm.text("Repaired the export.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, chat.id, "thanks", { agent: "quick" })
        const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
        // This engine sizes the app's quick-lane message: the work waits on the answer, so it runs at the work's size.
        expect(toolNames(bodies[0])).toEqual(expect.arrayContaining(["task", "todowrite"]))
        expect(isJudge(bodies[1]!)).toBe(true)
        // The judge checks the work's own report, not the reply's "You're welcome!".
        expect(JSON.stringify(bodies[1]?.messages)).toContain("Migrated all 40 routes")
        expect(JSON.stringify(bodies[1]?.messages)).not.toContain("You're welcome!")
        // A FAIL is repaired on the build agent with the work's tools, then judged again.
        expect(toolNames(bodies[2])).toEqual(expect.arrayContaining(["write", "task", "todowrite"]))
        expect(bodies[2]?.reasoning_effort).toBe("high")
        expect(bodies.filter(isJudge)).toHaveLength(2)
        expect((yield* sessions.children(chat.id)).length).toBe(2)
        // A quick-lane greeting afterwards has nothing to judge.
        yield* llm.text("Hi!")
        yield* send(prompt, chat.id, "hi", { agent: "quick" })
        expect((yield* sessions.children(chat.id)).length).toBe(2)
      }),
    { git: true },
  )

  it.instance(
    "a no to the agent's question is answered inside the work at its size, and the judge is told the answer",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        for (const question of [
          "Migrated 20 of 40 routes to the new router. Should I convert them to the new loader API?",
          "Migrated the router and left the old API in place. Do you want me to keep the old API for compatibility?",
        ]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
          yield* llm.text(question)
          yield* send(prompt, chat.id, LARGE)
          // Not judged while it waits on the answer.
          expect((yield* sessions.children(chat.id)).length, question).toBe(0)
          const before = (yield* llm.inputs).length
          yield* llm.text("Understood.")
          yield* llm.text("VERDICT: PASS")
          yield* send(prompt, chat.id, "no")
          const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
          // The answer runs with the work's harness and sees the question it answers.
          expect(toolNames(bodies[0]), question).toEqual(expect.arrayContaining(["task", "todowrite"]))
          expect(bodies[0]?.reasoning_effort, question).toBe("high")
          expect(JSON.stringify(bodies[0]?.messages), question).toContain(question.slice(-40))
          expect(isJudge(bodies[1]!), question).toBe(true)
          // The judge reads the question, the user's "no" and that declined work is out of scope.
          const brief = JSON.stringify(bodies[1]?.messages)
          expect(brief, question).toContain(question.slice(-40))
          expect(brief, question).toContain("<user>\\nno\\n</user>")
          expect(brief, question).toContain("Work they declined, or that the agent only offered, is out of scope")
          expect((yield* sessions.children(chat.id)).length, question).toBe(1)
        }
      }),
    { git: true },
  )

  it.instance(
    "an approval or build it after a Thorough plan from Plan mode carries it out at its size, and the judge checks it",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        for (const answer of ["build it", "build the app", "implement the migration", "looks good, build it", "yes"]) {
          const planner = "plan"
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Here is the plan in three phases: the renderer, the input layer, then the views.")
          yield* send(prompt, chat.id, "be thorough and plan how to port the TUI to Rust", { agent: planner })
          const before = (yield* llm.inputs).length
          yield* llm.tool("write", { filePath: path.join(directory, "tui.rs"), content: "fn main() {}\n" })
          yield* llm.text("Ported the renderer.")
          yield* llm.text("VERDICT: PASS")
          const result = yield* send(prompt, chat.id, answer)
          const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
          expect(toolNames(bodies[0]), answer).toEqual(expect.arrayContaining(["task", "task_manage", "todowrite"]))
          expect(bodies[0]?.reasoning_effort, answer).toBe("high")
          expect(result.info.role === "assistant" && result.info.size, answer).toBe("thorough")
          const judged = bodies.filter(isJudge)
          expect(judged, answer).toHaveLength(1)
          expect(JSON.stringify(judged[0]?.messages), answer).toContain("port the TUI to Rust")
          expect((yield* sessions.children(chat.id)).length, answer).toBe(1)
        }
        // On the build agent a plan that asked nothing has ended with its run: "build it" is Work, not judged, and the
        // agent can escalate it.
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Here is the plan in three phases: the renderer, the input layer, then the views.")
        yield* send(prompt, chat.id, "be thorough and plan how to port the TUI to Rust")
        const before = (yield* llm.inputs).length
        yield* llm.tool("write", { filePath: path.join(directory, "tui.rs"), content: "fn main() {}\n" })
        yield* llm.text("Ported the renderer.")
        const result = yield* send(prompt, chat.id, "build it")
        const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
        expect(toolNames(bodies[0])).toEqual(expect.arrayContaining(WORK))
        expect(toolNames(bodies[0])).not.toContain("task")
        expect(result.info.role === "assistant" && result.info.size).toBe("standard")
        expect(judgeRequests(bodies)).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "a yes to a greeting reply's offer gets the history and the work's tools",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({})
        yield* llm.text("Hi! Should I take a look at the failing tests in this repository?")
        yield* send(prompt, chat.id, "hi")
        yield* llm.text("Looking at them now.")
        yield* send(prompt, chat.id, "yes")
        const bodies = (yield* llm.inputs).filter((body) => !isTitle(body))
        expect(bodies).toHaveLength(2)
        expect(toolNames(bodies[0])).toEqual(QUICK)
        expect(toolNames(bodies[1])).toEqual(expect.arrayContaining(WORK))
        expect(conversation(bodies[1]).length).toBeGreaterThan(1)
        expect(JSON.stringify(bodies[1]?.messages)).toContain("failing tests in this repository")
      }),
    { git: true },
  )

  it.instance(
    "/init is Work: the normal tools, no subagents, the provider's own effort",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Wrote AGENTS.md.")
        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "init",
          arguments: "",
          model: "lmstudio/north-mini-code",
        })
        const [body] = (yield* llm.inputs).filter((item) => !isTitle(item))
        expect(toolNames(body)).toEqual(expect.arrayContaining(WORK))
        expect(toolNames(body)).not.toContain("task")
        expect(body?.reasoning_effort).toBeUndefined()
        expect(result.info.role === "assistant" && result.info.size).toBe("standard")
      }),
    { git: true },
  )

  it.instance(
    "a command is Work whatever its template says, and only the user's own arguments ask for Thorough",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup({
          command: {
            tidy: { template: "fix the typo in README.md" },
            careful: { template: "Be thorough and use subagents. Explain $ARGUMENTS" },
          },
        })
        const run = (command: string, args: string) =>
          Effect.gen(function* () {
            const chat = yield* sessions.create({ title: "Pinned" })
            yield* llm.text("Done.")
            yield* prompt.command({ sessionID: chat.id, command, arguments: args, model: "lmstudio/north-mini-code" })
          })
        yield* run("tidy", "")
        // A template's force words are its author's text, not the user's ask; the user's own arguments are.
        yield* run("careful", "the parser")
        yield* run("tidy", "be thorough")
        const [tidy, template, argument] = (yield* llm.inputs).filter((body) => !isTitle(body))
        for (const body of [tidy, template]) {
          expect(toolNames(body)).toEqual(expect.arrayContaining(WORK))
          expect(toolNames(body)).not.toContain("task")
          expect(body?.reasoning_effort).toBeUndefined()
        }
        expect(toolNames(argument)).toEqual(expect.arrayContaining(["task", "todowrite"]))
        expect(argument?.reasoning_effort).toBe("high")
      }),
    { git: true },
  )

  it.instance(
    "the off switch gives every request the full harness",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup({ sizing: { auto: false } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Hello.")
        yield* send(prompt, chat.id, "hi")
        const [body] = (yield* llm.inputs).filter((item) => !isTitle(item))
        expect(toolNames(body)).toContain("task")
      }),
    { git: true },
  )

  it.instance(
    "the sender's size wins, and a Light pick only leaves out the to-do list",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        const thorough = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Hello.")
        yield* send(prompt, thorough.id, "hi", { size: "thorough" })
        const light = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Done.")
        yield* send(prompt, light.id, "ship to vercel", { size: "light" })
        const [large, small] = (yield* llm.inputs).filter((item) => !isTitle(item))
        expect(toolNames(large)).toContain("task")
        expect(toolNames(small)).toEqual(expect.arrayContaining(WORK.filter((tool) => tool !== "todowrite")))
        expect(toolNames(small)).not.toContain("todowrite")
        expect(small?.reasoning_effort).toBeUndefined()
        expect(systemText(small)).toContain("<completion_policy>")
      }),
    { git: true },
  )

  it.instance(
    "after a finished, judged Thorough migration, ship to vercel and fix the typo in README are Work with no judge",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated all 40 files.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, chat.id, LARGE)
        expect((yield* sessions.children(chat.id)).length).toBe(1)
        yield* llm.text("You're welcome!")
        yield* send(prompt, chat.id, "thanks")
        for (const [text, file] of [
          ["ship to vercel", "vercel.json"],
          ["fix the typo in README", "README.md"],
        ] as const) {
          const before = (yield* llm.inputs).length
          yield* llm.tool("write", { filePath: path.join(directory, file), content: "{}\n" })
          yield* llm.text("Done.")
          const result = yield* send(prompt, chat.id, text)
          const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
          expect(bodies, text).toHaveLength(2)
          for (const body of bodies) {
            expect(toolNames(body), text).toEqual(expect.arrayContaining(WORK))
            expect(toolNames(body), text).not.toContain("task")
            expect(body?.reasoning_effort, text).toBeUndefined()
          }
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
        }
        // The migration keeps its one verdict, and Work is not judged in "Large tasks" mode.
        expect((yield* llm.inputs).filter(isJudge)).toHaveLength(1)
        expect((yield* sessions.children(chat.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "a run that ends on a question and a courtesy line is not judged until the user answers",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const closings = [
          "Migrated the router. Should I also remove the old API? Let me know!",
          "Migrated the router. Want me to proceed with phase 2? 🙂",
          "Migrated the router. Shall I continue with the input layer? Just say the word.",
          "Migrated the router. Should I keep the old API, or remove it? (I'd lean toward removing it.)",
          // A question that is not the reply's last sentence still asks (the verifier's probes).
          "Migrated the router. Should I also remove the old API? I'll wait for your answer.",
          "Migrated the router. Should I also remove the old API? Once you confirm, I'll proceed.",
          "Migrated the router. Which do you prefer for the old API: remove it or keep a shim? I'd go with the shim.",
          "Should I also remove the old API?\n\n**Summary of changes:**\n- router.ts migrated",
        ]
        for (const closing of closings) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
          yield* llm.text(closing)
          yield* send(prompt, chat.id, "be thorough: migrate the app to the new router and remove the old API if safe")
          // No judge yet, so no FAIL that would have the agent act before the user answers.
          expect((yield* sessions.children(chat.id)).length, closing).toBe(0)
          yield* llm.text("Understood: I left the rest as it is.")
          yield* llm.text("VERDICT: PASS")
          yield* send(prompt, chat.id, "no")
          expect((yield* sessions.children(chat.id)).length, closing).toBe(1)
        }
        const judged = (yield* llm.inputs).filter(isJudge)
        expect(judged).toHaveLength(closings.length)
        // The judge is told what the agent asked and what the user answered.
        expect(JSON.stringify(judged[0]?.messages)).toContain("Should I also remove the old API?")
      }),
    { git: true },
  )

  it.instance(
    "asking whether the fix worked gets the history and the tools, not the quick lane",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "login.ts"), content: "export {}\n" })
        yield* llm.text("Fixed the login redirect loop.")
        yield* send(prompt, chat.id, "fix the login redirect loop")
        for (const text of ["the tests passed?", "fixed?"]) {
          const before = (yield* llm.inputs).length
          yield* llm.text("Yes: the login tests pass.")
          const result = yield* send(prompt, chat.id, text)
          const [body] = (yield* llm.inputs).slice(before).filter((item) => !isTitle(item))
          expect(toolNames(body), text).toEqual(expect.arrayContaining(WORK))
          expect(body?.reasoning_effort, text).toBeUndefined()
          expect(JSON.stringify(body?.messages), text).toContain("redirect loop")
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
        }
      }),
    { git: true },
  )

  it.instance(
    "a greeting or a help with a pasted log gets the tools at the provider's effort",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions } = yield* setup()
        for (const text of [
          "hi\nnpm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree",
          "help\n2026-10-18T10:00:00Z ERROR db connection refused",
        ]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("Two packages want different versions of react.")
          const result = yield* send(prompt, chat.id, text)
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
        }
        const bodies = (yield* llm.inputs).filter((item) => !isTitle(item))
        expect(bodies).toHaveLength(2)
        for (const body of bodies) {
          expect(toolNames(body)).toEqual(expect.arrayContaining(WORK))
          expect(body?.reasoning_effort).toBeUndefined()
        }
      }),
    { git: true },
  )

  it.instance(
    "common thanks wordings after finished Thorough work, and a thanks after an any-changes closing, cost one bare request",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup()
        for (const [closing, thanks] of [
          ["Migrated all 40 files.", "got it, thanks"],
          ["Migrated all 40 files.", "thank u"],
          ["Migrated all 40 files.", "sounds great, thanks"],
          ["Migrated all 40 files. Let me know if you'd like any changes.", "thanks"],
          ["Migrated all 40 files. Let me know if anything else comes up.", "thanks"],
        ] as const) {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
          yield* llm.text(closing)
          yield* send(prompt, chat.id, LARGE)
          const before = (yield* llm.inputs).length
          yield* llm.text("You're welcome!")
          const result = yield* send(prompt, chat.id, thanks)
          const bodies = (yield* llm.inputs).slice(before).filter((item) => !isTitle(item))
          expect(bodies, thanks).toHaveLength(1)
          expect(toolNames(bodies[0]), thanks).toEqual(QUICK)
          expect(bodies[0]?.reasoning_effort, thanks).toBe("none")
          expect(conversation(bodies[0]), thanks).toHaveLength(1)
          expect(result.info.role === "assistant" && result.info.size, thanks).toBe("chat")
        }
      }),
    { git: true },
  )

  it.instance(
    "the user's no subagents holds: escalate cannot bring in subagents or the judge",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        for (const text of [
          "migrate the app to the new router across 40 files, no subagents",
          "don't be thorough, just migrate the app to the new router across 40 files",
        ]) {
          const chat = yield* sessions.create({ title: "Pinned" })
          const before = (yield* llm.inputs).length
          yield* llm.tool("escalate", { reason: "every route changes" })
          yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
          yield* llm.text("Migrated the router.")
          const result = yield* send(prompt, chat.id, text)
          const bodies = (yield* llm.inputs).slice(before).filter((item) => !isTitle(item))
          expect(bodies, text).toHaveLength(3)
          // Escalate is not offered on a capped request, and a call to it raises nothing.
          expect(toolNames(bodies[0]), text).not.toContain("escalate")
          for (const body of bodies) {
            expect(toolNames(body), text).not.toContain("task")
            expect(toolNames(body), text).not.toContain("task_manage")
            expect(body?.reasoning_effort, text).toBeUndefined()
          }
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
          expect((yield* sessions.children(chat.id)).length, text).toBe(0)
        }
        // On a caching provider escalate keeps its place in the tool list, and refuses.
        const chat = yield* sessions.create({ title: "Pinned" })
        const before = (yield* llm.inputs).length
        yield* llm.tool("escalate", { reason: "every route changes" })
        yield* llm.text("Migrated the router.")
        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: cached,
          parts: [{ type: "text", text: "migrate the app to the new router across 40 files, no subagents" }],
        })
        const bodies = (yield* llm.inputs).slice(before).filter((item) => !isTitle(item))
        expect(toolNames(bodies[0])).toContain("escalate")
        expect(JSON.stringify(bodies[1]?.messages)).toContain("The user asked not to use subagents")
        expect(toolNames(bodies[1])).not.toContain("task")
        expect((yield* sessions.children(chat.id)).length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "a Thorough plan approved through plan_exit is judged once the build that carries it out changes files",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Here is the plan in three phases.")
        yield* send(prompt, chat.id, "be thorough and plan how to port the TUI to Rust", { agent: "plan" })
        // What plan_exit writes when the user approves the plan: a synthetic message on the build agent.
        const approval: SessionV1.User = {
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: ref,
        }
        yield* sessions.updateMessage(approval)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: approval.id,
          sessionID: chat.id,
          type: "text",
          text: "The plan at plan.md has been approved, you can now edit files. Execute the plan",
          synthetic: true,
        } satisfies SessionV1.TextPart)
        const before = (yield* llm.inputs).length
        yield* llm.tool("write", { filePath: path.join(directory, "tui.rs"), content: "fn main() {}\n" })
        yield* llm.text("Ported the TUI.")
        yield* llm.text("VERDICT: PASS")
        const result = yield* prompt.loop({ sessionID: chat.id })
        const bodies = (yield* llm.inputs).slice(before).filter((body) => !isTitle(body))
        expect(result.info.role === "assistant" && result.info.size).toBe("thorough")
        expect(toolNames(bodies[0])).toEqual(expect.arrayContaining(["task", "task_manage", "todowrite"]))
        const judged = bodies.filter(isJudge)
        expect(judged).toHaveLength(1)
        expect(JSON.stringify(judged[0]?.messages)).toContain("port the TUI to Rust")
        expect((yield* sessions.children(chat.id)).length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "after a judged Thorough migration whose report ends on a closing line, a new request is Work and not judged again",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        for (const closing of [
          "Migrated the router. Let me know if this works for you.",
          "Migrated the router. I recommend running the e2e suite before you merge.",
          "Migrated the router. Let me know if you'd like me to make any other changes.",
        ]) {
          for (const text of ["fix the typo in README", UNRELATED]) {
            const chat = yield* sessions.create({ title: "Pinned" })
            yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
            yield* llm.text(closing)
            yield* llm.text("VERDICT: PASS")
            yield* send(prompt, chat.id, LARGE)
            const before = (yield* llm.inputs).length
            yield* llm.tool("write", { filePath: path.join(directory, "README.md"), content: "# fixed\n" })
            yield* llm.text("Done.")
            const result = yield* send(prompt, chat.id, text)
            const all = (yield* llm.inputs).slice(before)
            const [body] = all.filter((item) => !isTitle(item))
            expect(toolNames(body), `${closing} ${text}`).toEqual(expect.arrayContaining(WORK))
            expect(toolNames(body), `${closing} ${text}`).not.toContain("task")
            expect(body?.reasoning_effort, `${closing} ${text}`).toBeUndefined()
            expect(result.info.role === "assistant" && result.info.size, `${closing} ${text}`).toBe("standard")
            expect(judgeRequests(all), `${closing} ${text}`).toBe(0)
            expect((yield* sessions.children(chat.id)).length, `${closing} ${text}`).toBe(1)
          }
        }
        // An offer with a question mark still waits: the answer stays Thorough and is judged.
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated the router. Want me to also update the docs?")
        yield* send(prompt, chat.id, LARGE)
        expect((yield* sessions.children(chat.id)).length).toBe(0)
        const before = (yield* llm.inputs).length
        yield* llm.tool("write", { filePath: path.join(directory, "docs.md"), content: "# docs\n" })
        yield* llm.text("Updated the docs.")
        yield* llm.text("VERDICT: PASS")
        const result = yield* send(prompt, chat.id, "yes, also update the docs")
        const bodies = (yield* llm.inputs).slice(before).filter((item) => !isTitle(item))
        expect(toolNames(bodies[0])).toEqual(expect.arrayContaining(["task", "task_manage"]))
        expect(result.info.role === "assistant" && result.info.size).toBe("thorough")
        expect(judgeRequests(bodies)).toBe(1)
      }),
    { git: true },
    // Several fake-server turns, the judge's among them.
    30_000,
  )

  it.instance(
    "thanks or hi after a Thorough report that ends on a closing line is one quick-lane request",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        for (const closing of [
          "Migrated the router. Let me know if this works for you.",
          "Migrated the router. Let me know if you'd like me to make any other changes.",
          "Migrated the router. You can confirm by running `bun dev`.",
          "Migrated the router. Let me know how it goes.",
        ]) {
          for (const text of ["thanks", "hi"]) {
            const chat = yield* sessions.create({ title: "Pinned" })
            yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
            yield* llm.text(closing)
            yield* llm.text("VERDICT: PASS")
            yield* send(prompt, chat.id, LARGE)
            const before = (yield* llm.inputs).length
            yield* llm.text("You're welcome!")
            const result = yield* send(prompt, chat.id, text)
            const bodies = (yield* llm.inputs).slice(before).filter((item) => !isTitle(item))
            expect(bodies, `${closing} ${text}`).toHaveLength(1)
            expect(toolNames(bodies[0]), `${closing} ${text}`).toEqual(QUICK)
            expect(bodies[0]?.reasoning_effort, `${closing} ${text}`).toBe("none")
            expect(result.info.role === "assistant" && result.info.size, `${closing} ${text}`).toBe("chat")
          }
        }
        // A thanks to an offer with a question mark answers it, at the work's size.
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.tool("write", { filePath: path.join(directory, "router.ts"), content: "export {}\n" })
        yield* llm.text("Migrated the router. Want me to also add tests?")
        yield* send(prompt, chat.id, LARGE)
        const before = (yield* llm.inputs).length
        yield* llm.text("You're welcome! I'll leave the tests.")
        yield* llm.text("VERDICT: PASS")
        yield* send(prompt, chat.id, "thanks")
        const [body] = (yield* llm.inputs).slice(before).filter((item) => !isTitle(item))
        expect(toolNames(body)).toEqual(expect.arrayContaining(["task", "todowrite"]))
      }),
    { git: true },
    // Several fake-server turns, the judge's among them.
    30_000,
  )

  it.instance(
    "after a Thorough review that changed nothing, new requests are Work and a typo fix is not judged",
    () =>
      Effect.gen(function* () {
        const { llm, prompt, sessions, directory } = yield* setup({ sizing: { judge: "thorough" } })
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.text("Found three issues in the auth module: weak hashing, no rate limit, and a token leak in logs.")
        yield* send(prompt, chat.id, "be thorough: review the auth module for security issues")
        for (const text of ["what does parseArgs do?", "run the tests", "fix the typo in README"]) {
          const before = (yield* llm.inputs).length
          if (text.startsWith("fix"))
            yield* llm.tool("write", { filePath: path.join(directory, "README.md"), content: "# fixed\n" })
          yield* llm.text("Done.")
          const result = yield* send(prompt, chat.id, text)
          const all = (yield* llm.inputs).slice(before)
          const [body] = all.filter((item) => !isTitle(item))
          expect(toolNames(body), text).toEqual(expect.arrayContaining(WORK))
          expect(toolNames(body), text).not.toContain("task")
          expect(body?.reasoning_effort, text).toBeUndefined()
          expect(result.info.role === "assistant" && result.info.size, text).toBe("standard")
          expect(judgeRequests(all), text).toBe(0)
        }
        expect((yield* sessions.children(chat.id)).length).toBe(0)
      }),
    { git: true },
  )
})
