import { expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { FSUtil } from "@vectordevai/core/fs-util"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { DEFAULT_REVIEW_CONFIG, type ModelFinding, type ReviewConfig } from "@vectordevai/core/review/types"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionID } from "../../src/session/schema"
import { ReviewMemoryFence } from "@vectordevai/core/review/memory-fence"
import { VECTORSCOPE_AGENT } from "@vectordevai/core/review/prompt"
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
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Review } from "../../src/review/run"
import { TestInstance, trustWorkspace } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpError, reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// Integration of Codium's resolved accounting kind, VectorScope request admission and durable SQLite history fences.
// All model traffic uses an owned loopback fixture; no gateway credentials, paid provider or benchmark corpus is used.

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
    snapshot: () => Effect.succeed({}),
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
    startAuth: () => Effect.die("unexpected MCP auth in review tests"),
    authenticate: () => Effect.die("unexpected MCP auth in review tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in review tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  SpendGuard.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
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
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

const it = testEffect(
  LayerNode.compile(root, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ] as const),
)

const TIMEOUT = 30_000
const LIST_SOURCE = "export function last(items: number[]) {\n  const index = items.length\n  return items[index]\n}\n"
const LIST = parseUnifiedDiff(
  [
    "diff --git a/src/list.ts b/src/list.ts",
    "--- a/src/list.ts",
    "+++ b/src/list.ts",
    "@@ -1,3 +1,4 @@",
    " export function last(items: number[]) {",
    "-  return items[items.length - 1]",
    "+  const index = items.length",
    "+  return items[index]",
    " }",
  ].join("\n"),
)

const finding = (overrides: Partial<ModelFinding> = {}): ModelFinding => ({
  path: "src/list.ts",
  line: 3,
  severity: "blocking",
  category: "bug",
  title: "Returns undefined for the last item",
  body: "items[items.length] is one past the end of the array.",
  confidence: 0.9,
  ...overrides,
})

const report = (findings: ModelFinding[] = []) => ({
  summary: "Changes last() to index past the end.",
  risk: "medium",
  files: [{ path: "src/list.ts", note: "last() rewritten" }],
  findings,
})

const config = (overrides: Partial<ReviewConfig> = {}): ReviewConfig => ({
  ...DEFAULT_REVIEW_CONFIG,
  verify: "blocking",
  ...overrides,
})

const local = (modelID: string) => ({
  providerID: ProviderV2.ID.make("lmstudio"),
  modelID: ModelV2.ID.make(modelID),
  context: 100_000,
  costKind: "free" as const,
})
// Three labs: Anthropic's first pass, OpenAI's check, Google's judge.
const FIRST = local("claude-first")
const CHECK = local("gpt-check")
const JUDGE_MODEL = local("gemini-judge")

function input(directory: string, overrides: Partial<Review.RunInput> = {}): Review.RunInput {
  return {
    directory,
    trigger: "local",
    trust: "trusted",
    base: "1".repeat(40),
    head: "2".repeat(40),
    mode: "full",
    files: LIST,
    anchors: LIST,
    skipped: [],
    context: {},
    prior: [],
    rules: "",
    config: config(),
    model: CHECK,
    triage: FIRST,
    knownPath: async () => true,
    ...overrides,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
function lastUserText(body: Record<string, unknown>) {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : []
  const user = messages.findLast((message) => isRecord(message) && message.role === "user")
  const content = isRecord(user) ? user.content : undefined
  if (typeof content === "string") return content
  const parts: unknown[] = Array.isArray(content) ? content : []
  return parts.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n")
}
const answering = (text: string) => (hit: { body: Record<string, unknown> }) => lastUserText(hit.body).includes(text)
const REVIEW = answering("You are Vector's code reviewer")
const VERIFY = answering("You are checking candidate findings")
const JUDGE = answering("You are the judge on a review panel")
const FINALIZE = answering("Stop investigating")

const useServer = Effect.gen(function* () {
  const test = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  const provider = testProviderConfig(llm.url)
  const base = provider.provider.lmstudio.models["test-model"]
  Object.assign(provider.provider.lmstudio.models, {
    "claude-first": { ...base, id: "claude-first", name: "First" },
    "gpt-check": { ...base, id: "gpt-check", name: "Check" },
    "gemini-judge": { ...base, id: "gemini-judge", name: "Judge" },
    "claude-other": { ...base, id: "claude-other", name: "Other" },
  })
  yield* fs.writeWithDirs(
    path.join(test.directory, "vector.json"),
    JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...provider }),
  )
  yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
  yield* Effect.promise(() => trustWorkspace(test.directory))
  return { llm, directory: test.directory }
})

const [ID] = Review.normalizeFindings([finding()], "review", LIST).map((item) => item.id)
const verdict = (value: "confirmed" | "rejected", reason: string) =>
  reply()
    .tool("StructuredOutput", { results: [{ id: ID, verdict: value, reason }] })
    .usage({ input: 1_000, output: 50 })

// The loopback model carries the resolved Codium kind through the real reviewer and request boundary.
// This checks shared accounting/history controls without impersonating or contacting the paid gateway.
it.instance(
  "Codium-selected VectorScope keeps per-attempt admission and durable parent-history fences",
  () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* useServer
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const model = { ...FIRST, costKind: "codium" as const }
      const attempts: Extract<Review.Observation, { type: "attempt" }>[] = []
      const run = input(directory, {
        model,
        triage: undefined,
        identity: VECTORSCOPE_AGENT,
        instructionsFromContext: true,
        context: { instructions: "Codium review must retain this exact owned context." },
        config: config({ maxSteps: 1, verify: "off" }),
        observe: (event) => {
          if (event.type === "attempt") attempts.push(event)
        },
      })
      yield* llm.pushMatch(REVIEW, httpError(503, { error: "synthetic retry" }))
      yield* llm.pushMatch(FINALIZE, httpError(503, { error: "synthetic finalizer" }))
      const capped = yield* Review.run(run)
      expect((yield* llm.hits).filter(REVIEW)).toHaveLength(1)
      expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(1)
      expect(attempts.filter((attempt) => attempt.admitted && attempt.phase === "turn")).toHaveLength(1)
      expect(attempts.filter((attempt) => attempt.admitted && attempt.phase === "finalize")).toHaveLength(1)
      expect(attempts.some((attempt) => !attempt.admitted && attempt.stop === "steps")).toBe(true)
      expect(capped.specialists).toEqual([{ name: "review", status: "stopped", steps: 0, detail: "steps" }])

      yield* llm.reset
      const parent = yield* sessions.create({ title: "Fenced synthetic Codium review" }, "owner")
      const memory = ReviewMemoryFence.make(database.db)
      yield* memory.mark(parent.id)
      expect(yield* memory.requiresLease(parent.id)).toBe(true)
      yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
      const fenced = yield* Review.run({ ...run, parentID: parent.id })
      expect(yield* llm.hits).toHaveLength(0)
      expect(fenced.specialists[0]?.status).toBe("failed")
      expect(fenced.report.findings).toEqual([])
      expect(fenced.sessions).toHaveLength(1)
      expect(yield* memory.requiresLease(SessionID.make(fenced.sessions[0]!))).toBe(true)
    }),
  TIMEOUT,
)

it.instance(
  "Codium token fences precede projection hooks for both verify and judge in a mixed-cost panel",
  () =>
    Effect.gen(function* () {
      const { llm, directory } = yield* useServer
      for (const target of ["verify", "judge"] as const) {
        yield* llm.reset
        const asked: Review.OverCap[] = []
        const priced = (model: ReturnType<typeof local>) => ({
          ...model,
          costKind: "priced" as const,
          price: { input: 10, output: 10 },
        })
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({
              input: target === "verify" ? Review.CODIUM_REVIEW_TOKEN_STOP : 2_000,
              output: 100,
            }),
        )
        yield* llm.pushMatch(
          VERIFY,
          verdict("confirmed", "Synthetic confirmation.").usage({
            input: Review.CODIUM_REVIEW_TOKEN_STOP,
            output: 100,
          }),
        )
        const outcome = yield* Review.run(
          input(directory, {
            model: target === "verify" ? priced(CHECK) : CHECK,
            triage: { ...FIRST, costKind: "codium" },
            judge: target === "judge" ? priced(JUDGE_MODEL) : JUDGE_MODEL,
            config: config({ panel: true, maxCostUsd: 0.000001 }),
            projection: { overCap: (decision) => (asked.push(decision), true) },
          }),
        )
        // The tiny dollar cap would ask the lifting hook without the token fence. Neither phase may do so.
        expect(asked).toEqual([])
        expect((yield* llm.hits).filter(target === "verify" ? VERIFY : JUDGE)).toHaveLength(0)
        expect(outcome.specialists.find((pass) => pass.name === target)).toMatchObject({
          status: "skipped",
          detail: "budget",
        })
        expect(outcome.specialists.find((pass) => pass.name === "review")?.status).toBe("ok")
      }
    }),
  TIMEOUT,
)
