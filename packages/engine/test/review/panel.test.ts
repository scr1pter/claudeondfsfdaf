import { describe, expect } from "bun:test"
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
import { buildSummaryBody } from "@vectordevai/core/review/format"
import { noteJudgeUnfinished, notePanelUnavailable } from "@vectordevai/core/review/second-lab"
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
import { ReviewModel } from "../../src/review/model"
import { Auth } from "@/auth"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { TestConfig } from "../fixture/config"
import { TestInstance, trustWorkspace } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// WP A35: the review panel and the second-lab line, through Review.run against the fake LLM. The three models are local
// test models whose names carry a vendor family, so Vector reads three labs from them (as it reads own keys').

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

describe("Review.run: the panel", () => {
  it.instance(
    "a judge from a third lab makes the final call, and the review counts three labs",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer
        yield* llm.pushMatch(
          REVIEW,
          reply().tool("StructuredOutput", report([finding()])).usage({ input: 2_000, output: 100 }),
        )
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        yield* llm.pushMatch(JUDGE, verdict("rejected", "The caller never passes an empty list."))
        const rejected = yield* Review.run(
          input(directory, { judge: JUDGE_MODEL, config: config({ panel: true }) }),
        )
        const hits = yield* llm.hits
        expect(hits.filter(REVIEW).map((hit) => hit.body.model)).toEqual(["claude-first"])
        expect(hits.filter(VERIFY).map((hit) => hit.body.model)).toEqual(["gpt-check"])
        expect(hits.filter(JUDGE).map((hit) => hit.body.model)).toEqual(["gemini-judge"])
        // The judge sees the check's verdict for each candidate.
        expect(lastUserText(hits.find(JUDGE)!.body)).toContain("Second reviewer: confirmed. Reproduced.")
        expect(rejected.specialists.map((item) => [item.name, item.status])).toEqual([
          ["review", "ok"],
          ["verify", "ok"],
          ["judge", "ok"],
        ])
        expect(rejected.passes?.map((pass) => [pass.name, pass.model])).toEqual([
          ["review", "lmstudio/claude-first"],
          ["verify", "lmstudio/gpt-check"],
          ["judge", "lmstudio/gemini-judge"],
        ])
        // The judge's rejection stands over the check's confirmation.
        expect(rejected.selection.inline).toEqual([])
        expect(rejected.selection.dropped).toContainEqual({ reason: "rejected-by-verify", count: 1 })
        expect(rejected.cost?.labs).toBe(3)
        expect(rejected.notes).toEqual([])
        expect(buildSummaryBody({ head: rejected.head, baseRef: "main", mode: "full", cost: rejected.cost })).toContain(
          "Checked by three labs",
        )

        // And a finding the check rejected is reported once the judge confirms it.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        yield* llm.pushMatch(VERIFY, verdict("rejected", "Looks intended."))
        yield* llm.pushMatch(JUDGE, verdict("confirmed", "items[index] reads past the end."))
        const confirmed = yield* Review.run(input(directory, { judge: JUDGE_MODEL, config: config({ panel: true }) }))
        expect(confirmed.selection.inline.map((item) => [item.id, item.verified])).toEqual([[ID, true]])
        expect(confirmed.cost?.labs).toBe(3)
      }),
    TIMEOUT,
  )

  it.instance(
    "without a judge from the caller, review.json's judgeModel is the panel's judge",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        yield* llm.pushMatch(JUDGE, verdict("confirmed", "Reproduced again."))
        const outcome = yield* Review.run(
          input(directory, { config: config({ panel: true, judgeModel: "lmstudio/gemini-judge" }) }),
        )
        expect((yield* llm.hits).filter(JUDGE).map((hit) => hit.body.model)).toEqual(["gemini-judge"])
        expect(outcome.selection.inline.map((item) => item.id)).toEqual([ID])
        expect(outcome.cost?.labs).toBe(3)
      }),
    TIMEOUT,
  )

  it.instance(
    "a panel the models cannot form runs without the judge and says why, and the second lab still counts",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        // A judge from the first pass's own lab.
        const outcome = yield* Review.run(
          input(directory, { judge: local("claude-other"), config: config({ panel: true }) }),
        )
        expect((yield* llm.hits).filter(JUDGE)).toEqual([])
        expect(outcome.specialists.map((item) => item.name)).toEqual(["review", "verify"])
        expect(outcome.notes).toEqual([notePanelUnavailable()])
        expect(outcome.selection.inline.map((item) => item.id)).toEqual([ID])
        expect(outcome.cost?.labs).toBe(2)
      }),
    TIMEOUT,
  )

  it.instance(
    "a judge that does not finish leaves the check's verdicts and says so",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        yield* llm.pushMatch(JUDGE, reply().text("I would rather not say."))
        yield* llm.pushMatch(FINALIZE, reply().text("Still nothing."))
        const outcome = yield* Review.run(input(directory, { judge: JUDGE_MODEL, config: config({ panel: true }) }))
        expect(outcome.specialists.at(-1)?.name).toBe("judge")
        expect(outcome.specialists.at(-1)?.status).toBe("failed")
        expect(outcome.notes).toEqual([noteJudgeUnfinished("lmstudio/gemini-judge")])
        expect(outcome.selection.inline.map((item) => [item.id, item.verified])).toEqual([[ID, true]])
        expect(outcome.cost?.labs).toBe(2)
      }),
    TIMEOUT,
  )

  it.instance(
    "the panel is off unless asked for, and models whose lab cannot be named get no line",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        const plain = yield* Review.run(input(directory, { judge: JUDGE_MODEL }))
        expect((yield* llm.hits).filter(JUDGE)).toEqual([])
        expect(plain.specialists.map((item) => item.name)).toEqual(["review", "verify"])
        expect(plain.cost?.labs).toBe(2)

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        const unnamed = yield* Review.run(
          input(directory, { triage: local("test-model"), config: config({ panel: true }), judge: JUDGE_MODEL }),
        )
        expect(unnamed.cost?.labs).toBeUndefined()
        expect(unnamed.notes).toEqual([notePanelUnavailable()])
      }),
    TIMEOUT,
  )
})

describe("Review.run: the Codium review token stop", () => {
  const codium = (model: ReturnType<typeof local>) => ({ ...model, costKind: "codium" as const })
  const big = () =>
    reply()
      .tool("StructuredOutput", report([finding()]))
      .usage({ input: Review.CODIUM_REVIEW_TOKEN_STOP, output: 100 })

  it.instance(
    "on Vector Codium the check and the judge do not start past the stop, and run under it",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer
        const onCodium = { model: codium(CHECK), triage: codium(FIRST), judge: codium(JUDGE_MODEL) }
        yield* llm.pushMatch(REVIEW, big())
        const stopped = yield* Review.run(input(directory, { ...onCodium, config: config({ panel: true }) }))
        expect((yield* llm.hits).filter((hit) => VERIFY(hit) || JUDGE(hit))).toEqual([])
        expect(stopped.specialists.map((item) => [item.name, item.status, item.detail])).toEqual([
          ["review", "ok", undefined],
          ["verify", "skipped", "budget"],
        ])
        // After a triage pass only what the check confirmed is reported, so nothing unchecked goes out.
        expect(stopped.selection.inline).toEqual([])
        // The count stays inside the runner: no note names a token figure.
        expect(stopped.notes.join(" ")).not.toMatch(/token/i)

        yield* llm.pushMatch(
          REVIEW,
          reply().tool("StructuredOutput", report([finding()])).usage({ input: 2_000, output: 100 }),
        )
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        yield* llm.pushMatch(JUDGE, verdict("confirmed", "Reproduced again."))
        const under = yield* Review.run(input(directory, { ...onCodium, config: config({ panel: true }) }))
        expect(under.specialists.map((item) => [item.name, item.status])).toEqual([
          ["review", "ok"],
          ["verify", "ok"],
          ["judge", "ok"],
        ])
        expect(under.selection.inline.map((item) => item.id)).toEqual([ID])
      }),
    TIMEOUT,
  )

  // P4d (F61): the CLI and GitHub reviews resolve the review model, and an explicit triageModel, through
  // resolveReviewModel; the runner picks the plan's pair only without a triageModel. This case runs the resolver on the
  // review model only and copies the kind it returns onto this file's loopback models (FIRST stands in for the triage
  // model), which run the passes. The resolver's answer for each input, an `exact` triageModel among them, is pinned in
  // model.test.ts, and the stop for a kind set by hand in the case above; the caller wiring is not run here (F78).
  it.instance(
    "the kind resolveReviewModel returns for a Vector Codium model is the one the runner's token stop reads",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer
        const codiumModel = {
          id: ModelV2.ID.make("vector-flash"),
          providerID: ProviderV2.ID.make("vector-plan"),
          api: { id: "vector-flash", url: "https://models.invalid/v1", npm: "@ai-sdk/openai-compatible" },
          name: "Vector Flash",
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 128_000, output: 8_000 },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
        } satisfies Provider.Model
        // Only what resolveReviewModel reads for an exact local model: the model, its server line, the user's config
        // and the provider's sign-in.
        const resolved = yield* ReviewModel.resolveReviewModel({
          trigger: "local",
          exact: "vector-plan/vector-flash",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Provider.Service, {
                getModel: () => Effect.succeed(codiumModel),
                line: () => Effect.succeed(undefined),
              }),
              TestConfig.layer(),
              Layer.mock(Auth.Service, { get: () => Effect.succeed(undefined) }),
              Layer.mock(ModelCatalog.Service, { get: () => Effect.succeed({}) }),
            ),
          ),
        )
        const costKind = resolved.costKind

        yield* llm.pushMatch(REVIEW, big())
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        const triaged = yield* Review.run(
          input(directory, { model: { ...CHECK, costKind }, triage: { ...FIRST, costKind } }),
        )
        expect(triaged.specialists.map((item) => [item.name, item.status, item.detail])).toEqual([
          ["review", "ok", undefined],
          ["verify", "skipped", "budget"],
        ])

        // No triage (no listed review roles, or a same-lab pair): the review model's own kind decides.
        yield* llm.pushMatch(REVIEW, big())
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        const single = yield* Review.run(
          input(directory, { model: { ...CHECK, costKind }, triage: { ...CHECK, costKind } }),
        )
        expect(single.specialists.map((item) => [item.name, item.status, item.detail])).toEqual([
          ["review", "ok", undefined],
          ["verify", "skipped", "budget"],
        ])
        expect((yield* llm.hits).filter(VERIFY)).toEqual([])
      }),
    TIMEOUT,
  )

  it.instance(
    "reviews that do not run on Vector Codium are not held to it",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer
        yield* llm.pushMatch(REVIEW, big())
        yield* llm.pushMatch(VERIFY, verdict("confirmed", "Reproduced."))
        const own = yield* Review.run(input(directory))
        expect(own.specialists.map((item) => [item.name, item.status])).toEqual([
          ["review", "ok"],
          ["verify", "ok"],
        ])
        expect(own.selection.inline.map((item) => item.id)).toEqual([ID])
      }),
    TIMEOUT,
  )
})
