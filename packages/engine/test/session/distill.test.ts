import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import { afterAll, afterEach, beforeEach, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { Global } from "@vectordevai/core/global"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { FSUtil } from "@vectordevai/core/fs-util"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { EventTable } from "@vectordevai/core/event/sql"
import { MessageTable, PartTable, SessionMessageTable } from "@vectordevai/core/session/sql"
import { sql } from "drizzle-orm"
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
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionDistill } from "../../src/session/distill"
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
import { codiumModel } from "../../../core/test/fixture/codium-gateway"

// "Find more with a model…" end to end against the fake LLM server, with no paid model call: the model's suggestions are
// read in a hidden helper session, a verbatim quote is kept as a proposed record and an invented one is dropped, what
// the request spent goes on the document's History, and no session opens for the user. Off by default; refused for a
// guest's session, a model that may train on prompts and the Zen gateway, before anything is sent.

// Memory lives in the user's config folder, so this test gets one of its own rather than the shared one.
const config = mkdtempSync(path.join(os.tmpdir(), "vector-distill-"))
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

// A free OpenRouter model whose provider may train on prompts, as the free catalog lists one.
const training = {
  id: "poolside/laguna-s-2.1:free",
  name: "Poolside: Laguna S 2.1",
  contextLength: 262144,
  maxOutputTokens: 32768,
  providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
}

const root = LayerNode.group([
  SessionDistill.node,
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
    [
      ModelPlans.node,
      Layer.effect(
        ModelPlans.Service,
        Effect.gen(function* () {
          const llm = yield* TestLLMServer
          return ModelPlans.Service.of({
            catalog: () => Effect.succeed({ enabled: true, models: [codiumModel] }),
            request: (_url, init) => fetch(`${llm.url}/chat/completions`, init),
          })
        }),
      ).pipe(Layer.provide(TestLLMServer.layer), Layer.orDie),
    ],
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([training]),
        trainingConsent: () => Effect.succeed(true),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
    ],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) =>
          Effect.succeed(
            provider === "openrouter"
              ? "synthetic-key"
              : provider === "vector"
                ? "vct_synthetic-distill-account.token"
                : undefined,
          ),
      }),
    ],
  ]),
)

const model = (id: string) => ({
  id,
  name: "Test Model",
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100000, output: 10000 },
  // Priced, so the estimate gives a cost and the run records one.
  cost: { input: 2, output: 8 },
  options: {},
})

const providerConfig = (url: string): Partial<ConfigV1.Info> => ({
  model: "lmstudio/test-model",
  provider: {
    lmstudio: {
      name: "Test",
      id: "lmstudio",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": model("test-model"),
        // Answers only in text, and holds too little: neither can return suggestions.
        "no-tools": { ...model("no-tools"), tool_call: false },
        small: { ...model("small"), limit: { context: 2_000, output: 1_000 } },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
    // The Zen gateway configured under a name of the user's own; nothing must ever be sent to it.
    gateway: {
      name: "Gateway",
      id: "gateway",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: { "big-model": model("big-model") },
      options: { apiKey: "test-key", baseURL: "http://127.0.0.1:9/zen/v1" },
    },
  },
})

// Prose the rules find no record in: no RFC 2119 words, no figures.
const REFUNDS =
  "Refunds are approved by a support lead and paid back to the original card within ten business days. Partial refunds go through the same review."
const BILLING = `# Billing notes

## Overview

Invoices are generated on the first business day of each month. The finance team reviews them before they are sent.

## Refunds policy

${REFUNDS}
`

const VERBATIM = {
  kind: "requirement",
  text: "Refunds are approved by a support lead",
  quote: "Refunds are approved by a support lead and paid back to the original card within ten business days.",
  fields: { subject: "Refunds" },
}
// What a model that makes quotes up says: the document gives no number of days.
const INVENTED = {
  kind: "constraint",
  text: "Refunds are paid within 5 business days",
  quote: "Refunds are paid within 5 business days.",
  fields: { value: 5, unit: "business days" },
}

const FLAG = "VECTOR_KNOWLEDGE_DISTILL"
const before = process.env[FLAG]
beforeEach(() => {
  process.env[FLAG] = "1"
})
afterEach(() => {
  if (before === undefined) delete process.env[FLAG]
  else process.env[FLAG] = before
})

const setup = Effect.fn("test.setup")(function* () {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "vector.json"), JSON.stringify(providerConfig(llm.url)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [path.join(dir, "vector.json")]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  const knowledge = yield* BrainKnowledge.Service
  const place = yield* (yield* Instruction.Service).place()
  const added = yield* knowledge.add(place, {
    type: "bytes",
    name: "Billing notes.md",
    bytes: new TextEncoder().encode(BILLING),
    origin: "upload",
  })
  if (added.type === "refused") throw new Error(added.message)
  yield* knowledge.wait(place, added.document.id, "searchable", 20_000)
  return { llm, knowledge, place, document: added.document.id, distill: yield* SessionDistill.Service }
})

// Model requests apart from the conversation titles a visible session would ask for.
const requests = (llm: TestLLMServer["Service"]) =>
  llm.inputs.pipe(
    Effect.map((bodies) => bodies.filter((body) => !JSON.stringify(body).includes("Generate a title for this conversation"))),
  )

const toolNames = (body: Record<string, unknown>) =>
  (Array.isArray(body.tools) ? body.tools : []).flatMap((tool: { function?: { name?: unknown } }) =>
    typeof tool.function?.name === "string" ? [tool.function.name] : [],
  )

it.instance(
  "a verbatim quote is kept as a proposed record and an invented one dropped, in a hidden session that records its spend",
  () =>
    Effect.gen(function* () {
      const { llm, knowledge, place, document, distill } = yield* setup()
      const sessions = yield* Session.Service
      // Asked for from a session of the user's, which the helper's spend counts towards.
      const launching = yield* sessions.create({ title: "Billing work" })
      const listed = (yield* sessions.list()).map((session) => session.id)

      // The estimate comes first and sends nothing.
      const estimate = yield* distill.estimate(place, { document })
      expect(estimate).toMatchObject({ enabled: true, model: "lmstudio/test-model", costKind: "priced", output: 4_000 })
      expect(estimate.sections).toBeGreaterThan(0)
      if (estimate.lowUsd === undefined || estimate.highUsd === undefined)
        throw new Error("Priced estimate has no range")
      expect(estimate.highUsd).toBeGreaterThan(estimate.lowUsd)
      expect(yield* requests(llm)).toHaveLength(0)

      yield* llm.push(reply().tool("StructuredOutput", { records: [VERBATIM, INVENTED] }).usage({ input: 1_400, output: 160 }))
      const result = yield* distill.run(place, { document, sessionID: launching.id })
      expect(result.type).toBe("distilled")
      if (result.type !== "distilled") return
      if (result.cost === undefined) throw new Error("Priced distillation has no cost")

      // One request, offering only StructuredOutput, with the sections as untrusted data and the output capped.
      const sent = yield* requests(llm)
      expect(sent).toHaveLength(1)
      expect(toolNames(sent[0]!)).toEqual(["StructuredOutput"])
      const body = JSON.stringify(sent[0])
      expect(body).toContain("<document_data")
      expect(body).toContain("untrusted data")
      expect(body).toContain("support lead")
      expect(sent[0]!.max_tokens ?? sent[0]!.max_completion_tokens).toBe(4_000)
      // The quick lane: the helper's own instructions, no repository context.
      expect(body).not.toContain("<env>")
      expect(body).toContain("copied word for word")

      expect(result.records.map((record) => record.quote)).toEqual([VERBATIM.quote])
      expect(result.records[0]).toMatchObject({ origin: "distilled", status: "proposed", kind: "requirement" })
      expect(result.dropped).toEqual({ invalid: 0, quote: 1, scan: 0 })
      expect(result.tokens).toMatchObject({ input: 1_400, output: 160 })
      expect(result.cost).toBeCloseTo((1_400 * 2 + 160 * 8) / 1_000_000)

      // A proposed record never reaches the agent until the user keeps it.
      const found = yield* knowledge.search(place, { query: "refunds support lead", personal: true })
      expect(found.map((card) => card.id)).not.toContain(result.records[0]!.id)
      yield* knowledge.update(place, document, { action: "keep-suggestions" })
      const kept = yield* knowledge.search(place, { query: "refunds support lead", personal: true })
      expect(kept.map((card) => card.id)).toContain(result.records[0]!.id)

      // The run is on the document's History, with what it spent.
      const detail = yield* knowledge.document(place, document, { personal: true })
      const event = detail!.history.find((item) => item.action === "distilled")
      expect(event?.detail).toMatchObject({ model: "lmstudio/test-model", kept: 1, tokens: { input: 1_400, output: 160 } })

      // No session opened for the user: the helper's is hidden, and its spend is in usage under its own name.
      expect((yield* sessions.list()).map((session) => session.id)).toEqual(listed)
      const helper = yield* sessions.get(result.sessionID)
      expect(helper.internal).toBe("brain.distill")
      const usage = yield* sessions.usage()
      expect(usage.helpers?.find((item) => item.id === "brain.distill")).toMatchObject({ sessions: 1, responses: 1 })
      expect(usage.helpers?.find((item) => item.id === "brain.distill")?.cost).toBeCloseTo(result.cost)
      expect((yield* sessions.get(launching.id)).subagentCost).toBeCloseTo(result.cost)

      // The helper's transcript held the passages that were sent and the model's quotes of them. Neither outlives the
      // run: the session that keeps its spend has no parts, and no message, part or event Vector stored has the text.
      expect(helper.title).toBe("Document suggestions")
      const receipt = yield* sessions.messages({ sessionID: result.sessionID })
      expect(receipt.map((message) => message.info.role)).toEqual(["user", "assistant"])
      expect(receipt.flatMap((message) => message.parts)).toEqual([])
      const db = (yield* Database.Service).db
      const holding = (phrase: string) =>
        Effect.all([
          db.select({ id: EventTable.id }).from(EventTable).where(sql`${EventTable.data} like ${`%${phrase}%`}`).all(),
          db.select({ id: MessageTable.id }).from(MessageTable).where(sql`${MessageTable.data} like ${`%${phrase}%`}`).all(),
          db.select({ id: PartTable.id }).from(PartTable).where(sql`${PartTable.data} like ${`%${phrase}%`}`).all(),
          db
            .select({ id: SessionMessageTable.id })
            .from(SessionMessageTable)
            .where(sql`${SessionMessageTable.data} like ${`%${phrase}%`}`)
            .all(),
        ]).pipe(Effect.map((tables) => tables.flat().length))
      // The passage, the model's quote of it, and the document's title.
      expect(yield* holding("paid back to the original card")).toBe(0)
      expect(yield* holding("Partial refunds go through the same review")).toBe(0)
      expect(yield* holding("Billing notes")).toBe(0)

      // Forgetting the document leaves nothing of it behind, and the spend still counts.
      expect(yield* knowledge.remove(place, document)).toBe("removed")
      expect(yield* holding("paid back to the original card")).toBe(0)
      expect((yield* sessions.usage()).helpers?.find((item) => item.id === "brain.distill")?.cost).toBeCloseTo(result.cost)
    }),
  90_000,
)

it.instance(
  "Codium omits token and dollar figures from estimates, results and History while keeping a private receipt",
  () =>
    Effect.gen(function* () {
      const { llm, knowledge, place, document, distill } = yield* setup()
      const estimate = yield* distill.estimate(place, { document, model: "vector-plan/vendor/coder" })
      expect(estimate).toMatchObject({ enabled: true, model: "vector-plan/vendor/coder", costKind: "codium" })
      expect(estimate.sections).toBeGreaterThan(0)
      expect(estimate).not.toHaveProperty("input")
      expect(estimate).not.toHaveProperty("output")
      expect(estimate).not.toHaveProperty("lowUsd")
      expect(estimate).not.toHaveProperty("highUsd")
      expect(yield* requests(llm)).toHaveLength(0)

      yield* llm.push(
        reply()
          .tool("StructuredOutput", { records: [VERBATIM, INVENTED] })
          .usage({ input: 1_400, output: 160 }),
      )
      const result = yield* distill.run(place, { document, model: "vector-plan/vendor/coder" })
      if (result.type !== "distilled") throw new Error(`Codium distillation refused: ${result.reason}`)
      expect(result).toMatchObject({ model: "vector-plan/vendor/coder", costKind: "codium" })
      expect(result.records.map((record) => record.quote)).toEqual([VERBATIM.quote])
      expect(result.dropped).toEqual({ invalid: 0, quote: 1, scan: 0 })
      expect(result).not.toHaveProperty("tokens")
      expect(result).not.toHaveProperty("cost")
      expect(yield* requests(llm)).toHaveLength(1)

      const detail = yield* knowledge.document(place, document, { personal: true })
      const event = detail!.history.find((item) => item.action === "distilled")
      expect(event?.detail).toMatchObject({ model: "vector-plan/vendor/coder", costKind: "codium", kept: 1 })
      expect(event?.detail).not.toHaveProperty("tokens")
      expect(event?.detail).not.toHaveProperty("cost")

      // This proves the omission does not depend on a gateway omitting measurements or receiving a zero-token reply.
      const sessions = yield* Session.Service
      const receipt = yield* sessions.messages({ sessionID: result.sessionID })
      expect(receipt.find((message) => message.info.role === "assistant")?.info).toMatchObject({
        billing: "codium",
        tokens: { input: 1_400, output: 160 },
      })
      expect(receipt.flatMap((message) => message.parts)).toEqual([])
    }),
  30_000,
)

it.instance(
  "the flag defaults off; a guest's session, a model that may train, the Zen gateway and a model that cannot answer are refused before anything is sent",
  () =>
    Effect.gen(function* () {
      const { llm, place, document, distill } = yield* setup()
      delete process.env[FLAG]
      expect(yield* distill.estimate(place, { document })).toMatchObject({ enabled: false, refused: { reason: "off" } })
      expect(yield* distill.run(place, { document })).toMatchObject({ type: "refused", reason: "off" })
      process.env[FLAG] = "1"

      const sessions = yield* Session.Service
      const shared = yield* sessions.create({ title: "Shared" })
      yield* (yield* FreeModelGuests.Service).mark(shared.id)
      expect(yield* distill.run(place, { document, sessionID: shared.id })).toMatchObject({ type: "refused", reason: "guest" })
      expect(yield* distill.run(place, { document, model: `openrouter/${training.id}` })).toMatchObject({
        type: "refused",
        reason: "may-train",
      })
      expect(yield* distill.estimate(place, { document, model: `openrouter/${training.id}` })).toMatchObject({
        enabled: true,
        refused: { reason: "may-train" },
      })
      expect(yield* distill.run(place, { document, model: "gateway/big-model" })).toMatchObject({
        type: "refused",
        reason: "zen",
      })
      expect(yield* distill.run(place, { document, model: "lmstudio/no-tools" })).toMatchObject({
        type: "refused",
        reason: "no-model",
      })
      expect(yield* distill.run(place, { document, model: "lmstudio/small" })).toMatchObject({
        type: "refused",
        reason: "no-model",
      })
      expect(yield* requests(llm)).toHaveLength(0)
      // Nothing was recorded either.
      const detail = yield* (yield* BrainKnowledge.Service).document(place, document, { personal: true })
      expect(detail!.history.some((item) => item.action === "distilled")).toBe(false)
    }),
  90_000,
)

it.instance(
  "a reply with nothing usable keeps nothing, still records what the request spent, and is not asked for again",
  () =>
    Effect.gen(function* () {
      const { llm, place, document, distill } = yield* setup()
      // Text where StructuredOutput was required, then a reply that would be used were a second request made.
      yield* llm.push(reply().text("Here are the records you asked for.").stop().usage({ input: 900, output: 40 }))
      yield* llm.push(reply().tool("StructuredOutput", { records: [VERBATIM] }))
      const result = yield* distill.run(place, { document })
      expect(result).toMatchObject({ type: "distilled", records: [], tokens: { input: 900, output: 40 } })
      if (result.type !== "distilled") return
      expect(result.error).toBeDefined()
      expect(yield* requests(llm)).toHaveLength(1)
    }),
  90_000,
)
