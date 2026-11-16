import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import { afterAll, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
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
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionMemory } from "../../src/session/memory"
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
import { TestLLMServer } from "../lib/llm-server"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { MessageID, type SessionID } from "../../src/session/schema"
import { sql } from "drizzle-orm"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { Brain } from "@vectordevai/core/brain/brain"

// Proven knowledge end to end, against the fake LLM server with no paid model call: a spec's card the answer cites, in
// a run where \`bun test\` fails and then passes, gains credit once the run is over; a card only recalled gains none;
// and reverting the run takes the credit back, counting it against the record but never against a memory entry.

// Memory lives in the user's config folder, so this test gets one of its own rather than the shared one.
const config = mkdtempSync(path.join(os.tmpdir(), "vector-knowledge-outcome-"))
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
  BrainDatabase.node,
  FreeModelGuests.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [Global.node, Global.layerWith({ config })],
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

const SPEC = `# Client spec

## 2 Limits

Clients MUST retry at most 3 times after a 429 response.
`

const PASSING = 'import { expect, test } from "bun:test"\n\ntest("retries", () => expect(3).toBe(3))\n'

const setup = Effect.fn("test.setup")(function* () {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify(providerConfig(llm.url)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  const knowledge = yield* BrainKnowledge.Service
  const brain = yield* Brain.Service
  const place = yield* (yield* Instruction.Service).place()
  const added = yield* knowledge.add(place, {
    type: "bytes",
    name: "Client spec.md",
    bytes: new TextEncoder().encode(SPEC),
    origin: "upload",
  })
  if (added.type === "refused") throw new Error(added.message)
  yield* knowledge.wait(place, added.document.id, "searchable", 20_000)
  const [record] = (yield* knowledge.records(place, { query: "retry 429", personal: true })).records
  const lesson = yield* brain.propose(place, {
    kind: "lesson",
    text: "Client retry changes need the retry tests run after a 429 change.",
    scope: "repository",
    origin: "user",
  })
  if (lesson.type === "refused") throw new Error(lesson.message)
  return { llm, knowledge, place, dir, record: record!, entry: lesson.entry.id }
})

const send = Effect.fn("test.send")(function* (sessionID: SessionID, text: string) {
  const llm = yield* TestLLMServer
  const prompt = yield* SessionPrompt.Service
  const before = (yield* llm.hits).length
  yield* prompt.prompt({ sessionID, agent: "build", model: ref, size: "standard", parts: [{ type: "text", text }] })
  return (yield* llm.hits).slice(before).map((hit) => JSON.stringify(hit.body))
})

const counts = Effect.fn("test.counts")(function* (ref: string, entry: string) {
  const db = (yield* BrainDatabase.Service).db
  const item = yield* db.get<{ helpful: number; harmful: number }>(
    sql`SELECT helpful, harmful FROM brain_item WHERE ref = ${ref}`,
  )
  const memory = yield* db.get<{ helpful: number; harmful: number }>(
    sql`SELECT helpful, harmful FROM brain_entry WHERE id = ${entry}`,
  )
  const credited = yield* db.all<{ entry: string }>(sql`SELECT entry_id AS entry FROM brain_event WHERE action = 'credited'`)
  return { item, memory, credited: credited.length }
})

// Credit is given in the background once the run is over.
const settled = Effect.fn("test.settled")(function* (ref: string, entry: string, credited: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const now = yield* counts(ref, entry)
    if (now.credited >= credited) return now
    yield* Effect.sleep(50)
  }
  return yield* counts(ref, entry)
})

const script = Effect.fn("test.script")(function* (dir: string, answer: string) {
  const llm = yield* TestLLMServer
  // No test file yet, so the check fails; the agent adds one and it passes.
  yield* llm.tool("bash", { command: "bun test", description: "Run the tests" })
  yield* llm.tool("write", { filePath: path.join(dir, "retry.test.ts"), content: PASSING })
  yield* llm.tool("bash", { command: "bun test", description: "Run the tests" })
  yield* llm.text(answer)
})

it.instance(
  "a cited card and memory entry in a run whose tests went from failing to passing gain one each; a revert takes it back",
  () =>
    Effect.gen(function* () {
      const { record, entry, dir } = yield* setup()
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* script(dir, `Retries now stop after three, as [${record.id}] says, and [${entry}] held.`)
      const hits = yield* send(chat.id, "make the client retry after a 429 response like the spec says")
      // The card and the entry were in the request, so citing them counts.
      expect(hits[0]).toContain(`[${record.id}]`)
      expect(hits[0]).toContain(`[${entry}]`)
      const passed = yield* settled(record.id, entry, 1)
      expect(passed.item).toEqual({ helpful: 1, harmful: 0 })
      expect(passed.memory).toEqual({ helpful: 1, harmful: 0 })

      // The user reverts the run: the record's credit goes and counts against it; the entry only loses its credit.
      const saved = yield* sessions.messages({ sessionID: chat.id })
      const request = saved.find((message) => message.info.role === "user")!
      const revert = yield* SessionRevert.Service
      yield* revert.revert({ sessionID: chat.id, messageID: request.info.id })
      yield* revert.cleanup(yield* sessions.get(chat.id))
      const after = yield* counts(record.id, entry)
      expect(after.item).toEqual({ helpful: 0, harmful: 1 })
      expect(after.memory).toEqual({ helpful: 0, harmful: 0 })
    }),
  { git: true },
  90_000,
)

it.instance(
  "a revert in a session a guest is in takes no credit back",
  () =>
    Effect.gen(function* () {
      const { record, entry, dir } = yield* setup()
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* script(dir, `Retries now stop after three, as [${record.id}] says, and [${entry}] held.`)
      yield* send(chat.id, "make the client retry after a 429 response like the spec says")
      const passed = yield* settled(record.id, entry, 1)
      expect(passed.item).toEqual({ helpful: 1, harmful: 0 })
      // A guest joins later and undoes the owner's run.
      const guests = yield* FreeModelGuests.Service
      yield* guests.mark(chat.id)
      const saved = yield* sessions.messages({ sessionID: chat.id })
      const request = saved.find((message) => message.info.role === "user")!
      const revert = yield* SessionRevert.Service
      yield* revert.revert({ sessionID: chat.id, messageID: request.info.id })
      yield* revert.cleanup(yield* sessions.get(chat.id))
      const after = yield* counts(record.id, entry)
      expect(after.item).toEqual({ helpful: 1, harmful: 0 })
      expect(after.memory).toEqual({ helpful: 1, harmful: 0 })
    }),
  { git: true },
  90_000,
)

it.instance(
  "a card recalled but neither cited nor opened gains nothing, though the tests went green",
  () =>
    Effect.gen(function* () {
      const { record, entry, dir } = yield* setup()
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      // A made-up id in the answer is no citation either.
      yield* script(dir, "Retries now stop after three [r0000000000000].")
      const hits = yield* send(chat.id, "make the client retry after a 429 response like the spec says")
      expect(hits[0]).toContain(`[${record.id}]`)
      const done = yield* settled(record.id, entry, 1)
      expect(done.credited).toBe(1)
      expect(done.item).toEqual({ helpful: 0, harmful: 0 })
      expect(done.memory).toEqual({ helpful: 0, harmful: 0 })
    }),
  { git: true },
  90_000,
)

it.instance(
  "a cited card in a run whose tests never went green gains nothing",
  () =>
    Effect.gen(function* () {
      const { llm, record, entry } = yield* setup()
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("bash", { command: "bun test", description: "Run the tests" })
      yield* llm.text(`Tests still fail; [${record.id}] needs a retry helper first.`)
      yield* send(chat.id, "make the client retry after a 429 response like the spec says")
      const done = yield* settled(record.id, entry, 1)
      expect(done.credited).toBe(1)
      expect(done.item).toEqual({ helpful: 0, harmful: 0 })
    }),
  { git: true },
  90_000,
)

it.instance(
  "a request whose run has not answered it yet is not credited until it has",
  () =>
    Effect.gen(function* () {
      const { record, entry, dir } = yield* setup()
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* script(dir, `Retries now stop after three, as [${record.id}] says.`)
      yield* send(chat.id, "make the client retry after a 429 response like the spec says")
      yield* settled(record.id, entry, 1)
      const saved = yield* sessions.messages({ sessionID: chat.id })
      // The turn as it was before its answer came: still at its tool calls.
      const answered = saved.filter((message) => message.info.role !== "user")
      expect(SessionMemory.finished(saved)).toBe(true)
      expect(SessionMemory.finished(saved.slice(0, 1))).toBe(false)
      expect(SessionMemory.finished(saved.slice(0, saved.indexOf(answered.at(-1)!)))).toBe(false)
    }),
  { git: true },
  90_000,
)
