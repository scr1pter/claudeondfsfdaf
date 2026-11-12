import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import { afterAll, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { LLMEvent } from "@vectordevai/llm"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainLearn } from "@vectordevai/core/brain/learn"
import { BrainSchema } from "@vectordevai/core/brain/schema"
import { Global } from "@vectordevai/core/global"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { FSUtil } from "@vectordevai/core/fs-util"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { FreeModels } from "@vectordevai/core/free-models"
import { MemoryEvent } from "@vectordevai/schema/memory-event"
import { SessionEvent } from "@vectordevai/schema/session-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionMemory } from "../../src/session/memory"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import type { SessionID } from "../../src/session/schema"

// Learning about you (section 6.3), end to end against the fake LLM server with no paid model call: what the user
// types at the end of each request teaches Vector their terms and preferences, by plain code. A greeting teaches nothing
// and costs nothing, pasted text vouches for nothing, a term comes back only when a request names it, what the user
// takes back stays out, and the optional model learner's suggestions in a session that read outside content only wait.

// Memory lives in the user's config folder, so this test gets one of its own rather than the shared one.
const config = mkdtempSync(path.join(os.tmpdir(), "vector-learn-"))
afterAll(() => rmSync(config, { recursive: true, force: true }))

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    snapshot: () => Effect.succeed({}),
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

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  SpendGuard.node,
  Auth.node,
  BrainKnowledge.node,
  Brain.node,
  FreeModelGuests.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const replacements = [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  [Global.node, Global.layerWith({ config })],
] as const
const it = testEffect(LayerNode.compile(root, replacements))

// The same stack where the user's own OpenRouter account lists a free model whose provider may train on prompts, the
// owner accepted that, and each model call is answered here and kept by the agent it was for, instead of sent anywhere.
const lagunaFree = {
  id: "poolside/laguna-s-2.1:free",
  name: "Poolside: Laguna S 2.1",
  contextLength: 262144,
  maxOutputTokens: 32768,
  providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
}
const laguna = { providerID: ProviderV2.ID.openrouter, modelID: ModelV2.ID.make(lagunaFree.id) }
const called: string[] = []
// What each model call would send: its system prompt and messages.
const sent: { readonly agent: string; readonly body: string }[] = []
const training = testEffect(
  LayerNode.compile(root, [
    ...replacements,
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([lagunaFree]),
        trainingConsent: () => Effect.succeed(true),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
    ],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "openrouter" ? "synthetic-key" : undefined),
      }),
    ],
    [
      LLM.node,
      Layer.succeed(LLM.Service, {
        stream: (input) => {
          called.push(input.agent.name)
          sent.push({
            agent: input.agent.name,
            body: JSON.stringify({
              system: [...(input.stableSystem ?? []), ...input.system],
              messages: input.messages,
            }),
          })
          return Stream.make(
            LLMEvent.textStart({ id: "reply" }),
            LLMEvent.textDelta({ id: "reply", text: "Done." }),
            LLMEvent.textEnd({ id: "reply" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          )
        },
      }),
    ],
  ]),
)

const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

const providerConfig = (url: string): Partial<ConfigV1.Info> => ({
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
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
})

const allow = [{ permission: "*", pattern: "*", action: "allow" as const }]

const TERM = "when I say ship it I mean open a PR, wait for CI, then merge"

const setup = Effect.fn("test.setup")(function* (extra: Partial<ConfigV1.Info> = {}) {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify({ ...providerConfig(llm.url), ...extra }))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  const brain = yield* Brain.Service
  const instruction = yield* Instruction.Service
  const place = yield* instruction.place()
  // The model learner runs with any model in these tests; by default it runs only with Vector Local on.
  yield* brain.setLearnSettings({ learning: true, modelLearner: "always" })
  return { llm, brain, place }
})

type Part = { type: "text"; text: string; metadata?: Record<string, unknown> }

// One prompt in a session of its own (or the one given), with the bodies of every model request it made.
const send = Effect.fn("test.send")(function* (input: {
  text?: string
  parts?: Part[]
  sessionID?: SessionID
  reply?: string
  agent?: string
}) {
  const llm = yield* TestLLMServer
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const sessionID = input.sessionID ?? (yield* sessions.create({ title: "Learn", permission: allow })).id
  const before = (yield* llm.hits).length
  yield* llm.text(input.reply ?? "Done.")
  yield* prompt.prompt({
    sessionID,
    agent: input.agent ?? "build",
    model: ref,
    parts: input.parts ?? [{ type: "text", text: input.text ?? "" }],
  })
  return { sessionID, bodies: (yield* llm.hits).slice(before).map((hit) => JSON.stringify(hit.body)) }
})

// What Vector learned on its own, of every state and in either scope.
const learned = Effect.fn("test.learned")(function* () {
  const brain = yield* Brain.Service
  const instruction = yield* Instruction.Service
  return (yield* brain.list(yield* instruction.place(), { filter: "all" })).filter((entry) => entry.origin === "agent")
})

// The model learner runs in the background once the run is over: wait until its request was made and answered.
const settled = Effect.fn("test.settled")(function* <R>(check: Effect.Effect<boolean, never, R>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (yield* check) return
    yield* Effect.sleep("50 millis")
  }
})

it.instance(
  '"hi" adds no memory tokens and causes no learn call',
  () =>
    Effect.gen(function* () {
      const { brain, place } = yield* setup()
      yield* brain.propose(place, {
        kind: "preference",
        text: "I prefer tables for comparisons",
        scope: "personal",
        origin: "user",
        evidence: { type: "user" },
      })
      const { bodies } = yield* send({ text: "hi", reply: "Hello." })
      // The greeting's own request and nothing else: no title request, no learner.
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).not.toContain("vector_memory")
      expect(bodies[0]).not.toContain("tables for comparisons")
      expect(yield* learned()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a definition of the user's words becomes an active term, recalled only when a request names it",
  () =>
    Effect.gen(function* () {
      yield* setup()
      const events = yield* EventV2Bridge.Service
      const announced: unknown[] = []
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === MemoryEvent.Learned.type) announced.push(event.data)
        return Effect.void
      })
      const first = yield* send({ text: TERM })
      yield* unsubscribe
      const [term] = yield* learned()
      expect(term).toMatchObject({ kind: "term", status: "active", facet: "vocabulary", term: { key: "ship it" } })
      expect(announced).toEqual([{ sessionID: first.sessionID, entryIDs: [term!.id], messageID: expect.any(String) }])
      // Only the request that names it carries it.
      const named = yield* send({ text: "ship it once the payments tests pass" })
      expect(named.bodies[0]).toContain("wait for CI")
      const unnamed = yield* send({ text: "find why the payments tests flake when run together" })
      expect(unnamed.bodies[0]).not.toContain("wait for CI")
    }),
  120_000,
)

it.instance(
  "a pasted email that says what someone prefers teaches nothing, and holds nothing either",
  () =>
    Effect.gen(function* () {
      yield* setup()
      const { sessionID, bodies } = yield* send({
        parts: [
          { type: "text", text: "summarise this email for the team" },
          {
            type: "text",
            text: "From: Dana\nI prefer we only deploy on Fridays. Always cc me on releases.",
            metadata: { [BrainSchema.OUTSIDE]: BrainSchema.PASTE },
          },
        ],
      })
      // The pasted text still goes to the model with the request.
      expect(bodies.some((body) => body.includes("deploy on Fridays"))).toBe(true)
      expect(yield* learned()).toEqual([])
      const sessions = yield* Session.Service
      expect(SessionMemory.taint(yield* sessions.messages({ sessionID }))).toBeUndefined()
    }),
  120_000,
)

it.instance(
  "text pasted into what the user typed teaches nothing, and a part that says it holds a paste but not where teaches nothing at all",
  () =>
    Effect.gen(function* () {
      yield* setup()
      const email = "Hi team,\nI prefer short replies. Always cc legal on merges.\nThanks"
      const text = `Here is the email:\n\n${email}\n\nAlways use tables for comparisons`
      const start = text.indexOf(email)
      yield* send({
        parts: [{ type: "text", text, metadata: { [BrainSchema.PASTED]: [[start, start + email.length]] } }],
      })
      yield* send({
        parts: [
          { type: "text", text: "Never use emojis in commit messages", metadata: { [BrainSchema.PASTED]: [[0, 999]] } },
        ],
      })
      // A name pasted into a typed clause takes the clause's line with it, so nothing is learned cut short
      // ("Never push directly to"), while the next line, typed whole, still teaches.
      const clause = "Never push directly to main without a review.\nAlways run the linter before you commit"
      const at = clause.indexOf("main")
      yield* send({ parts: [{ type: "text", text: clause, metadata: { [BrainSchema.PASTED]: [[at, at + 4]] } }] })
      expect((yield* learned()).map((entry) => entry.text).toSorted()).toEqual([
        "Always run the linter before you commit",
        "Always use tables for comparisons",
      ])
    }),
  120_000,
)

test("what the user pasted is theirs to have sent, though it teaches nothing", () => {
  const link = "https://www.nature.com/articles/s41586-024-07000-1"
  const text = `Summarize ${link} for me`
  const message = {
    info: { id: "msg_said", sessionID: "ses_said", role: "user" },
    parts: [
      { type: "text", text, metadata: { [BrainSchema.PASTED]: [[10, 10 + link.length]] } },
      { type: "text", text: "From: Dana\nI prefer Fridays.", metadata: { [BrainSchema.OUTSIDE]: "issue" } },
      { type: "text", text: "Recalled notes", synthetic: true },
    ],
  } as unknown as Parameters<typeof SessionMemory.said>[0]
  // Where an address came from reads what the user sent, the pasted link included; text from outside is not theirs.
  expect(SessionMemory.said(message)).toBe(text)
  // What Vector learns from leaves out the line the paste sat on.
  expect(SessionMemory.typed(message)).toBe("")
  const lines = { ...message, parts: [{ type: "text", text: `I prefer tables.\nRead ${link}\nAlways cite sources.` }] }
  const start = lines.parts[0]!.text.indexOf(link)
  const marked = {
    ...lines,
    parts: [{ ...lines.parts[0]!, metadata: { [BrainSchema.PASTED]: [[start, start + link.length]] } }],
  } as unknown as Parameters<typeof SessionMemory.typed>[0]
  expect(SessionMemory.typed(marked)).toBe("I prefer tables.\n\n\n\n\nAlways cite sources.")
  expect(SessionMemory.said(marked)).toBe(`I prefer tables.\nRead ${link}\nAlways cite sources.`)
})

it.instance(
  "in the user's own voice a step of the task teaches nothing, and what names something of one repository stays with it",
  () =>
    Effect.gen(function* () {
      yield* setup()
      yield* send({ text: "I'd rather you didn't touch the migrations folder while you refactor" })
      yield* send({ text: "I prefer you keep the Acme billing client as is for this PR" })
      yield* send({ text: "I prefer option B" })
      expect(yield* learned()).toEqual([])
      yield* send({ text: "I prefer Acme's Q3 churn numbers to come from the internal dashboard" })
      yield* send({ text: "I prefer tables for comparisons" })
      expect(Object.fromEntries((yield* learned()).map((entry) => [entry.text, entry.scope]))).toEqual({
        "I prefer Acme's Q3 churn numbers to come from the internal dashboard": "repository",
        "I prefer tables for comparisons": "personal",
      })
    }),
  120_000,
)

it.instance(
  "a sensitive first-person fact is dropped while a research-topic preference survives",
  () =>
    Effect.gen(function* () {
      yield* setup()
      yield* send({ text: "I prefer short answers because I have ADHD. I prefer FDA sources for diabetes research." })
      expect((yield* learned()).map((entry) => [entry.text, entry.facet])).toEqual([
        ["I prefer FDA sources for diabetes research", "sources"],
      ])
    }),
  120_000,
)

it.instance(
  "one message teaches at most three things",
  () =>
    Effect.gen(function* () {
      yield* setup()
      yield* send({ text: "Always use tables. Never use emojis. Always cite sources inline. Never squash merge." })
      expect(yield* learned()).toHaveLength(BrainLearn.LIMIT.perMessage)
    }),
  120_000,
)

it.instance(
  "Undo writes a tombstone, and the same words in a later session are not learned again",
  () =>
    Effect.gen(function* () {
      const { brain, place } = yield* setup()
      yield* send({ text: "Always use tables for comparisons" })
      const [entry] = yield* learned()
      expect(entry?.status).toBe("active")
      yield* brain.update(place, entry!.id, { action: "undo" }, "user")
      yield* send({ text: "Always use tables for comparisons" })
      expect((yield* learned()).map((item) => item.status)).toEqual(["archived"])
    }),
  120_000,
)

it.instance(
  "the model learner's suggestion in a session that read outside content is written proposed only",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const suggestion = JSON.stringify({
        items: [{ kind: "preference", text: "Use pnpm for the workspace", quote: "use pnpm for the workspace" }],
      })
      // The learner's request carries its own instructions; the main request gets the plain reply.
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("standing preference"), suggestion)
      const { sessionID } = yield* send({
        parts: [
          { type: "text", text: "no, I meant use pnpm for the workspace" },
          {
            type: "text",
            text: "Issue #12: the install step fails on CI",
            metadata: { [BrainSchema.OUTSIDE]: "issue" },
          },
        ],
      })
      yield* settled(learned().pipe(Effect.map((items) => items.length > 0)))
      // The quote says nothing about the user themselves, so it stays with this repository.
      expect((yield* learned()).map((entry) => [entry.text, entry.status, entry.scope])).toEqual([
        ["Use pnpm for the workspace", "proposed", "repository"],
      ])
      // Its request went to the session's model as a helper, with no tools and the user's message alone as the text.
      const asked = (yield* llm.hits)
        .map((hit) => JSON.stringify(hit.body))
        .filter((body) => body.includes("standing preference"))
      expect(asked).toHaveLength(1)
      expect(asked[0]).toContain("use pnpm for the workspace")
      expect(asked[0]).not.toContain('"tools"')
      const sessions = yield* Session.Service
      expect(SessionMemory.taint(yield* sessions.messages({ sessionID }))).toBe("web")
    }),
  120_000,
)

it.instance(
  "the model learner stays off unless the user lets it run, and never runs where the rules found something",
  () =>
    Effect.gen(function* () {
      const { llm, brain } = yield* setup()
      yield* brain.setLearnSettings({ modelLearner: "local-only" })
      const before = yield* llm.calls
      yield* send({ text: "no, I meant use pnpm for the workspace" })
      yield* brain.setLearnSettings({ modelLearner: "always" })
      yield* send({ text: "no, I meant it. Always use pnpm for the workspace" })
      yield* Effect.sleep("200 millis")
      // Two main requests and the first session's title, and no learner request: Vector Local is off for the first,
      // and the rules learned the second.
      const asked = (yield* llm.hits)
        .slice(before)
        .filter((hit) => JSON.stringify(hit.body).includes("standing preference"))
      expect(asked).toEqual([])
      expect((yield* learned()).map((entry) => entry.text)).toEqual(["Always use pnpm for the workspace"])
    }),
  120_000,
)

it.instance(
  "words inside a quote that spans lines, runs long or sits in single quotes teach nothing",
  () =>
    Effect.gen(function* () {
      yield* setup()
      yield* send({ text: 'Bob replied:\n"Thanks.\nAlways cc me on releases."\nCan you draft a reply?' })
      yield* send({ text: "He said 'Always use tabs. Never use spaces.' in the doc. Can you check the style guide?" })
      yield* send({
        text: `The vendor wrote "${"Here is some background on the rollout. ".repeat(10)}Always deploy on Fridays." Summarise it for me.`,
      })
      expect(yield* learned()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a step of the task and a request to name what it makes teach nothing, and an instruction of no general kind stays with the repository",
  () =>
    Effect.gen(function* () {
      yield* setup()
      yield* send({ text: "Fix the flaky test, but don't change the public API" })
      yield* send({ text: "Don't touch the migrations folder while you refactor" })
      yield* send({ text: "Add a date helper, call it parseDate" })
      expect(yield* learned()).toEqual([])
      yield* send({ text: "Never call the billing client directly" })
      yield* send({ text: "Always use tables for comparisons" })
      const scopes = new Map((yield* learned()).map((entry) => [entry.text, entry.scope]))
      expect(Object.fromEntries(scopes)).toEqual({
        "Never call the billing client directly": "repository",
        "Always use tables for comparisons": "personal",
      })
    }),
  120_000,
)

// A model learner's request, by the instructions it carries.
const learnerRequest = (hit: { body: unknown }) => JSON.stringify(hit.body).includes("standing preference")

it.instance(
  "the session's next prompt cancels the model learner still reading the last one, and a learner that runs counts as memory",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const events = yield* EventV2Bridge.Service
      const usage: unknown[] = []
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === SessionEvent.AncillaryUsage.type) usage.push(event.data)
        return Effect.void
      })
      const suggest = (text: string, quote: string) => JSON.stringify({ items: [{ kind: "preference", text, quote }] })
      // The learner's answer waits until the session's next prompt has started.
      const release = Promise.withResolvers<void>()
      yield* llm.pushMatch(
        (hit) => learnerRequest(hit) && JSON.stringify(hit.body).includes("pnpm"),
        reply().wait(release.promise).text(suggest("Use pnpm for the workspace", "use pnpm for the workspace")).stop(),
      )
      const cancelled = yield* send({ text: "no, I meant use pnpm for the workspace" })
      yield* settled(llm.hits.pipe(Effect.map((hits) => hits.some(learnerRequest))))
      expect((yield* llm.hits).filter(learnerRequest)).toHaveLength(1)
      yield* send({ sessionID: cancelled.sessionID, text: "thanks, now look at the failing build" })
      release.resolve()
      yield* Effect.sleep("300 millis")
      expect(yield* learned()).toEqual([])
      // A learner nothing cancels writes what it found, and its request counts in its own session, as memory.
      yield* llm.textMatch(
        (hit) => learnerRequest(hit) && JSON.stringify(hit.body).includes("yarn"),
        suggest("Use yarn for the docs site", "use yarn for the docs site"),
      )
      const kept = yield* send({ text: "no, I meant use yarn for the docs site" })
      yield* settled(learned().pipe(Effect.map((items) => items.length > 0)))
      yield* unsubscribe
      expect((yield* learned()).map((entry) => entry.text)).toEqual(["Use yarn for the docs site"])
      expect(usage).toContainEqual(expect.objectContaining({ sessionID: kept.sessionID, purpose: "memory" }))
    }),
  120_000,
)

training.instance(
  "the model learner never runs on a free model that may train on prompts",
  () =>
    Effect.gen(function* () {
      yield* setup()
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "Learn", permission: allow })
      called.length = 0
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: laguna,
        parts: [{ type: "text", text: "no, I meant use pnpm for the workspace" }],
      })
      yield* Effect.sleep("300 millis")
      expect(called).toContain("build")
      expect(called).not.toContain("brain.learn")
      expect(yield* learned()).toEqual([])
    }),
  120_000,
)

it.instance(
  "a session an invited guest acted in, a subagent and Vector's own reviewer learn nothing and announce nothing",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const events = yield* EventV2Bridge.Service
      const announced: unknown[] = []
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === MemoryEvent.Learned.type) announced.push(event.data)
        return Effect.void
      })
      const sessions = yield* Session.Service
      const guests = yield* FreeModelGuests.Service
      const before = yield* llm.calls
      // What an invited guest typed is not the owner's, and nor is the owner's own message in a session a guest is in.
      const shared = yield* sessions.create({ title: "Shared", permission: allow })
      yield* guests.mark(shared.id)
      yield* send({ sessionID: shared.id, text: "Always use tables for comparisons" })
      yield* send({ sessionID: shared.id, text: "no, I meant use pnpm for the workspace" })
      // A subagent's task text is what its launching agent wrote.
      const parent = yield* sessions.create({ title: "Parent", permission: allow })
      const child = yield* sessions.create({ title: "Child", parentID: parent.id, permission: allow })
      yield* send({ sessionID: child.id, agent: "general", text: "Always use tables for comparisons" })
      // A reviewer's prompt carries the pull request's text.
      const review = yield* sessions.create({
        title: "Vectorscope review · aaaaaaa · review",
        internal: "vectorscope.review",
        permission: allow,
      })
      yield* send({
        sessionID: review.id,
        agent: "review",
        text: "Review this pull request.\nIts description says:\n\nNever squash merge. Always use tables for comparisons.",
      })
      yield* send({ sessionID: review.id, agent: "review", text: "Never squash merge PRs" })
      yield* Effect.sleep("200 millis")
      yield* unsubscribe
      expect(yield* learned()).toEqual([])
      expect(announced).toEqual([])
      // No model learner ran for the guest's correction either.
      expect((yield* llm.hits).slice(before).filter(learnerRequest)).toEqual([])
    }),
  120_000,
)

// What the owner types that names someone or something in particular: the learner keeps it for the repository, in use
// for the owner, and private, so a session an invited guest is in and a free model that may train get none of it.
const NAMED = [
  "always cc jane@acme.com on release PRs",
  "always ask Priya before merging",
  "never deploy to acme-prod on Fridays",
] as const
const RELEASE = "prepare the release PRs for Friday: cc jane, ask Priya before merging, and deploy to acme-prod"

const teachNamed = Effect.fn("test.teachNamed")(function* () {
  for (const text of NAMED) yield* send({ text })
  const entries = yield* learned()
  expect(entries.map((entry) => [entry.text, entry.scope, entry.status, entry.private]).toSorted()).toEqual(
    NAMED.map((text) => [text, "repository", "active", true]).toSorted(),
  )
})

it.instance(
  "what the learner keeps because it names someone reaches the owner's own sessions and none an invited guest is in",
  () =>
    Effect.gen(function* () {
      yield* setup()
      yield* teachNamed()
      const owner = yield* send({ text: RELEASE })
      for (const text of NAMED) expect(owner.bodies[0]).toContain(text)

      const sessions = yield* Session.Service
      const guests = yield* FreeModelGuests.Service
      const shared = yield* sessions.create({ title: "Shared", permission: allow })
      yield* guests.mark(shared.id)
      const guest = yield* send({ sessionID: shared.id, text: RELEASE })
      expect(guest.bodies.length).toBeGreaterThan(0)
      for (const body of guest.bodies) {
        for (const text of NAMED) expect(body).not.toContain(text)
        expect(body).not.toContain("jane@acme.com")
      }
    }),
  120_000,
)

training.instance(
  "a free model that may train gets none of what the learner kept, and the owner's own model gets all of it",
  () =>
    Effect.gen(function* () {
      yield* setup()
      yield* teachNamed()
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const ask = Effect.fnUntraced(function* (model: typeof ref) {
        const session = yield* sessions.create({ title: "Release", permission: allow })
        sent.length = 0
        yield* prompt.prompt({ sessionID: session.id, agent: "build", model, parts: [{ type: "text", text: RELEASE }] })
        return sent.filter((item) => item.agent === "build").map((item) => item.body)
      })
      const own = yield* ask(ref)
      expect(own.length).toBeGreaterThan(0)
      for (const text of NAMED) expect(own.join("\n")).toContain(text)
      const trains = yield* ask(laguna)
      expect(trains.length).toBeGreaterThan(0)
      for (const body of trains) {
        for (const text of NAMED) expect(body).not.toContain(text)
        expect(body).not.toContain("jane@acme.com")
      }
    }),
  120_000,
)

it.instance(
  "each message of a run keeps its own cap: what the learner writes for one leaves the next its three, and the memory tool's writes count",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const session = yield* sessions.create({ title: "Learn", permission: allow })
      // The first message's reply waits until the user has steered the run with a second message.
      const release = Promise.withResolvers<void>()
      yield* llm.pushMatch(
        (hit) => JSON.stringify(hit.body).includes("Always cite sources inline"),
        reply().wait(release.promise).text("Thinking.").stop(),
      )
      yield* llm.text("Done.")
      const running = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "Always use tables. Never use emojis. Always cite sources inline." }],
        })
        .pipe(Effect.forkScoped)
      while (!(yield* llm.hits).some((hit) => JSON.stringify(hit.body).includes("Always cite sources inline")))
        yield* Effect.sleep(10)
      const steer = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "Never squash merge PRs" }],
        })
        .pipe(Effect.forkScoped)
      while (
        (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.info.role === "user").length <
        2
      )
        yield* Effect.sleep(10)
      release.resolve()
      yield* Fiber.join(running)
      yield* Fiber.join(steer)
      const steered = (yield* learned()).map((entry) => entry.text)
      expect(steered.toSorted()).toEqual([
        "Always cite sources inline",
        "Always use tables",
        "Never squash merge PRs",
        "Never use emojis",
      ])

      // A message whose answer saved a memory with the memory tool has two places left for what the learner reads.
      yield* llm.tool("memory", {
        action: "add",
        kind: "decision",
        text: "Staging deploys only from the release branch.",
        quote: "we deploy staging from the release branch only",
      })
      yield* llm.text("Noted.")
      const tool = yield* sessions.create({ title: "Learn", permission: allow })
      yield* prompt.prompt({
        sessionID: tool.id,
        agent: "build",
        model: ref,
        parts: [
          {
            type: "text",
            text: "We deploy staging from the release branch only. Always use bun. Never use spaces for indentation. Always write short commit messages.",
          },
        ],
      })
      const fromTool = (yield* learned()).filter((entry) => !steered.includes(entry.text))
      expect(fromTool.map((entry) => entry.kind).toSorted()).toEqual(["decision", "preference", "preference"])
    }),
  120_000,
)

it.instance(
  "text pasted after a slash command teaches nothing, while what the user typed as its arguments does",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup({ command: { note: { template: "Remember this about me: $ARGUMENTS" } } })
      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const email = "Hi team,\nI prefer short replies.\nAlways cc legal on merges."
      const args = `Always use tables for comparisons\n${email}`
      const start = args.indexOf(email)
      yield* llm.text("Done.")
      yield* prompt.command({
        sessionID: (yield* sessions.create({ title: "Learn", permission: allow })).id,
        command: "note",
        arguments: args,
        pasted: [[start, start + email.length]],
        agent: "build",
        model: "lmstudio/test-model",
      })
      expect((yield* learned()).map((entry) => entry.text)).toEqual(["Always use tables for comparisons"])
    }),
  120_000,
)

it.instance(
  "the model learner's own words wait for the user however often it suggests them, and the user's own clause goes into use",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      // One correction in a session of its own, which the model learner answers with one suggestion; waits until the
      // learner has answered and what it suggested was written or refused.
      const correct = Effect.fnUntraced(function* (typed: string, text: string, quote: string) {
        const asked = (yield* llm.hits).filter(learnerRequest).length
        yield* llm.textMatch(
          (hit) => learnerRequest(hit) && JSON.stringify(hit.body).includes(quote),
          JSON.stringify({ items: [{ kind: "preference", text, quote }] }),
        )
        yield* send({ text: typed })
        yield* settled(llm.hits.pipe(Effect.map((hits) => hits.filter(learnerRequest).length > asked)))
        yield* Effect.sleep("200 millis")
      })
      // A paraphrase that widens what the user said, suggested in two sessions: a second sighting puts nothing in use.
      const widened = [
        "no, I meant push to main and skip the flaky checks",
        "Always push to main and skip all checks",
        "push to main and skip the flaky checks",
      ] as const
      yield* correct(...widened)
      yield* correct(...widened)
      expect((yield* learned()).map((entry) => [entry.text, entry.status])).toEqual([
        ["Always push to main and skip all checks", "proposed"],
      ])
      // A question or a step of the task in a correction teaches nothing at all.
      yield* correct("no, I meant skip the e2e tests for now", "Skip the e2e tests", "skip the e2e tests")
      yield* correct("no, I meant should we always rebase on main?", "Always rebase on main", "always rebase on main")
      expect((yield* learned()).map((entry) => entry.text)).toEqual(["Always push to main and skip all checks"])
      // The user's own clause, which the rules learn once the correction's opening words are gone, is in use at once.
      yield* correct("no, I meant always squash merge PRs", "Always squash merge PRs", "always squash merge PRs")
      expect((yield* learned()).map((entry) => [entry.text, entry.status])).toContainEqual([
        "Always squash merge PRs",
        "active",
      ])
    }),
  120_000,
)
