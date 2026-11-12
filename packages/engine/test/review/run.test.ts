import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Stream } from "effect"
import { LLMEvent, Usage } from "@vectordevai/llm"
import { Database } from "@vectordevai/core/database/database"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Global } from "@vectordevai/core/global"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { FSUtil } from "@vectordevai/core/fs-util"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { parseReviewConfig } from "@vectordevai/core/review/config"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { PINNED_SESSION_PREFIX, VECTORSCOPE_AGENT } from "@vectordevai/core/review/prompt"
import { certificateProblems, evidenceScope, type ModelCertificate } from "@vectordevai/core/review/model-evidence"
import {
  noteTriageFixedUnchecked,
  noteTriageUnchecked,
  noteVerifySkipped,
  noteVerifyUnfinished,
} from "@vectordevai/core/review/format"
import {
  DEFAULT_REVIEW_CONFIG,
  type ModelFinding,
  type ReviewConfig,
  type ReviewCost,
  type ReviewOutcome,
} from "@vectordevai/core/review/types"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../../src/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { PromptTrust } from "@/config/prompt-trust"
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
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { Review } from "../../src/review/run"
import { ReviewService } from "../../src/review/service"
import { ReviewLocalRun } from "../../src/review/local-run"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { ReviewLifecycle } from "../../src/review/lifecycle"
import { SessionID } from "../../src/session/schema"
import { TestInstance, trustWorkspace, reloadInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { httpError, reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { resolveReviewModel, type ResolveInput } from "../../src/review/model"

// Review.run against the fake LLM. Requests are matched by the prompt they answer, since the review and security
// sessions run in parallel.

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
  Auth.node,
  ModelCatalog.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  BackgroundJobStore.node,
  ReviewRequestStore.node,
  ReviewLifecycle.node,
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

const replacements = [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const it = testEffect(LayerNode.compile(root, replacements))

const TIMEOUT = 30_000
const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }
const PRICE = { input: 10, output: 10 } // USD per million tokens

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
const AUTH = parseUnifiedDiff(
  [
    "diff --git a/src/auth/session.ts b/src/auth/session.ts",
    "--- a/src/auth/session.ts",
    "+++ b/src/auth/session.ts",
    "@@ -1,3 +1,3 @@",
    " export function token(input: string) {",
    "-  return verify(input)",
    "+  return input",
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

const report = (findings: ModelFinding[] = [], summary = "Changes last() to index past the end.") => ({
  summary,
  risk: "medium",
  files: [{ path: "src/list.ts", note: "last() rewritten" }],
  findings,
})

const config = (overrides: Partial<ReviewConfig> = {}): ReviewConfig => ({
  ...DEFAULT_REVIEW_CONFIG,
  verify: "off",
  ...overrides,
})

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
    model: { ...ref, context: 100_000, costKind: "priced" },
    knownPath: async () => true,
    ...overrides,
  }
}

const priced = { ...ref, context: 100_000, costKind: "priced" as const, price: PRICE }

const ownerSettings = (settings: Record<string, unknown>) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const file = path.join(Global.Path.config, "vector.json")
    const previous = yield* Effect.promise(() =>
      fs.readFile(file).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
        throw error
      }),
    )
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify(settings))
        Config.refreshLocal()
        Config.confirmLocal()
      }).pipe(Effect.andThen(PromptTrust.accept([file])), Effect.andThen(config.invalidate())),
      () =>
        Effect.promise(async () => {
          if (previous === undefined) await fs.rm(file, { force: true })
          else await fs.writeFile(file, previous)
          Config.refreshLocal()
          Config.confirmLocal()
        }).pipe(Effect.andThen(PromptTrust.accept([file])), Effect.andThen(config.invalidate())),
    )
    // These cases model a global edit the owner approved. An unapproved
    // replacement is correctly stripped by Config.withheld before any review.
    expect(PromptTrust.allowed(file)).toBe(true)
  })

const useServer = (
  cost?: typeof PRICE,
  options: { compaction?: { auto: boolean }; agent?: { review?: { prompt: string } } } = {},
) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    const provider = testProviderConfig(llm.url)
    if (cost) provider.provider.lmstudio.models["test-model"].cost = cost
    yield* fs.writeWithDirs(
      path.join(test.directory, "vector.json"),
      JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...provider, ...options }),
    )
    yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
    yield* Effect.promise(() => trustWorkspace(test.directory))
    return { llm, directory: test.directory }
  })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const localOwnerFixture = Effect.gen(function* () {
  const { llm, directory } = yield* useServer()
  yield* ownerSettings({ agent: { vectorscope: { model: "lmstudio/test-model" } } })
  const files = yield* FSUtil.Service
  const git = yield* Git.Service
  const runGit = (args: string[]) =>
    git.run(args, { cwd: directory }).pipe(
      Effect.map((result) => {
        expect(result.exitCode).toBe(0)
        return result.text().trim()
      }),
    )
  yield* files.writeWithDirs(
    path.join(directory, ".vector/review.json"),
    JSON.stringify({ security: "off", verify: "off" }),
  )
  yield* files.writeWithDirs(
    path.join(directory, "src/list.ts"),
    "export function last(items: number[]) {\n  return items[items.length - 1]\n}\n",
  )
  yield* runGit(["add", "."])
  yield* runGit(["commit", "-m", "local review deletion base"])
  const head = yield* runGit(["rev-parse", "HEAD"])
  yield* files.writeWithDirs(path.join(directory, "src/list.ts"), LIST_SOURCE)
  const settings = yield* Config.Service
  yield* settings.approve()
  yield* reloadInstance({ directory })
  expect((yield* settings.trust()).trusted).toBe(true)
  expect((yield* (yield* Provider.Service).getModel(ref.providerID, ref.modelID).pipe(Effect.orDie)).id).toBe(
    ref.modelID,
  )
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "Deletion race owner" }, "owner")
  return {
    llm,
    sessions,
    parent,
    source: {
      sessionID: parent.id,
      directory,
      worktree: directory,
      permission: [{ permission: "*", pattern: "*", action: "allow" as const }],
    },
    request: { requestID: "actual_provider_deletion", target: { kind: "working-tree" as const, head } },
  }
})

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
const SECURITY = answering("You are Vector's security reviewer")
const VERIFY = answering("You are checking candidate findings")
const FINALIZE = answering("Stop investigating")

function toolNames(body: Record<string, unknown>): string[] {
  const tools: unknown[] = Array.isArray(body.tools) ? body.tools : []
  return tools.flatMap((tool) => {
    const fn = isRecord(tool) && isRecord(tool.function) ? tool.function : undefined
    return typeof fn?.name === "string" ? [fn.name] : []
  })
}

const modelRequests = (llm: TestLLMServer["Service"]) =>
  llm.inputs.pipe(
    Effect.map((bodies) =>
      bodies.filter((body) => !JSON.stringify(body).includes("Generate a title for this conversation")),
    ),
  )

// Exercise the processor's real partial-usage persistence. This boundary fixture reports a numeric started total,
// then fails or interrupts before completion; HTTP fixtures above cover the regular full-stream path.
for (const reason of ["error", "abort", "reduced"] as const) {
  // Review and security run in parallel, and nothing else orders security's first admission against review's step.
  // Once review's step settles it holds its finalize reservation until its report is decoded, and a security
  // admission that lands in that window is refused for budget: its started, unfinished attempt never runs, adds no
  // uncertain exposure, and verify then fits. Review's first reply waits here until security's stream is pulled,
  // which the processor does only after admitting it, so the attempt this test is about always runs.
  const securityAdmitted = Promise.withResolvers<void>()
  const partial = testEffect(
    LayerNode.compile(root, [
      ...replacements,
      [
        LLM.node,
        Layer.succeed(
          LLM.Service,
          LLM.Service.of({
            stream: (input) =>
              Stream.suspend(() => {
                const text = JSON.stringify(input.messages.at(-1) ?? {})
                if (input.agent.name === "security" && !text.includes("Stop investigating")) {
                  securityAdmitted.resolve()
                  input.started?.(
                    reason === "reduced"
                      ? { inputTokens: 40_000, outputTokens: 100, totalTokens: 40_100 }
                      : { inputTokens: 1_000, outputTokens: 1, totalTokens: 1_001 },
                  )
                  return Stream.make(
                    LLMEvent.stepStart({ index: 0 }),
                    LLMEvent.textStart({ id: "partial" }),
                    LLMEvent.textDelta({ id: "partial", text: "Investigating" }),
                  ).pipe(
                    Stream.concat(
                      reason === "reduced"
                        ? Stream.make(
                            LLMEvent.stepFinish({
                              index: 0,
                              reason: "error",
                              usage: new Usage({ inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 }),
                            }),
                            LLMEvent.finish({ reason: "error" }),
                          )
                        : reason === "error"
                          ? Stream.fail(new Error("stream failed"))
                          : Stream.fromEffect(Effect.interrupt),
                    ),
                  )
                }
                const verify = text.includes("You are checking candidate findings")
                const gate =
                  input.agent.name === "review" && !verify && !text.includes("Stop investigating")
                    ? Stream.fromEffect(Effect.promise(() => securityAdmitted.promise)).pipe(Stream.drain)
                    : Stream.empty
                return gate.pipe(
                  Stream.concat(
                    Stream.make(
                      LLMEvent.stepStart({ index: 0 }),
                      LLMEvent.textStart({ id: "answer" }),
                      LLMEvent.textDelta({
                        id: "answer",
                        text: JSON.stringify(
                          verify ? { results: [] } : report(input.agent.name === "review" ? [finding()] : []),
                        ),
                      }),
                      LLMEvent.textEnd({ id: "answer" }),
                      LLMEvent.stepFinish({
                        index: 0,
                        reason: "stop",
                        usage: new Usage(
                          input.agent.name === "review"
                            ? { inputTokens: 30_000, outputTokens: 100, totalTokens: 30_100 }
                            : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                        ),
                      }),
                      LLMEvent.finish({ reason: "stop" }),
                    ),
                  ),
                )
              }),
          }),
        ),
      ],
    ]),
  )
  partial.instance(
    `retains incomplete ${reason} usage even when its started report includes a numeric total`,
    () =>
      Effect.gen(function* () {
        const { directory } = yield* useServer(PRICE)
        const outcome = yield* Review.run(
          input(directory, {
            model: priced,
            config: config({ maxCostUsd: reason === "reduced" ? 0.8 : 0.57, security: "always", verify: "blocking" }),
          }),
        )
        expect(outcome.specialists.at(-1)).toEqual({ name: "verify", status: "skipped", steps: 0, detail: "budget" })
        expect(outcome.sessions).toHaveLength(2)
        expect(outcome.cost?.costUsd).toBeCloseTo(reason === "reduced" ? 0.312 : 0.31101, 6)
        const sessions = yield* Session.Service
        const messages = yield* sessions.messages({ sessionID: SessionID.make(outcome.sessions[1]!) })
        expect(messages.flatMap((message) => message.parts)).toContainEqual(
          expect.objectContaining({
            type: "step-finish",
            reason: reason === "reduced" ? "error" : reason,
            tokens: expect.objectContaining({ total: reason === "reduced" ? 1_100 : 1_001 }),
          }),
        )
        expect(outcome.notes).toContain(
          "Reported cost may be incomplete; work with uncertain usage retained its estimated budget exposure for this review.",
        )
      }),
    TIMEOUT,
  )
}

describe("Review.run", () => {
  for (const variant of [false, true])
    it.instance(
      `pinned context survives actual OpenAI Responses ${variant ? "variant" : "model"} instruction options`,
      () =>
        Effect.gen(function* () {
          yield* ownerSettings({
            agent: { vectorscope: { model: "openai/gpt-5.5", ...(variant ? { variant: "high" } : {}) } },
          })
          const test = yield* TestInstance
          const llm = yield* TestLLMServer
          const fs = yield* FSUtil.Service
          yield* fs.writeWithDirs(
            path.join(test.directory, "vector.json"),
            JSON.stringify({
              formatter: false,
              lsp: false,
              provider: {
                openai: {
                  npm: "@ai-sdk/openai",
                  options: { apiKey: "responses-local-test-only", baseURL: llm.url, concurrency: 64 },
                  models: {
                    "gpt-5.5": {
                      id: "gpt-5.5",
                      name: "Responses test",
                      tool_call: true,
                      reasoning: true,
                      limit: { context: 100_000, output: 10_000 },
                      cost: { input: 0, output: 0 },
                      options: {
                        instructions: "AMBIENT_RESPONSES_MODEL_MARKER",
                        systemMessageMode: "remove",
                        truncation: "auto",
                        ...(!variant ? { conversation: "conv_ambient_model" } : {}),
                      },
                      variants: {
                        high: {
                          instructions: "AMBIENT_RESPONSES_VARIANT_MARKER",
                          systemMessageMode: "remove",
                          truncation: "auto",
                          previousResponseId: "resp_ambient_variant",
                          reasoningEffort: "low",
                        },
                      },
                    },
                  },
                },
              },
            }),
          )
          yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
          yield* Effect.promise(() => trustWorkspace(test.directory))
          const selected = yield* resolveReviewModel({ trigger: "local", identity: VECTORSCOPE_AGENT })
          for (const pinned of [false, true]) {
            yield* llm.reset
            yield* llm.push(reply().tool("StructuredOutput", report([])))
            const outcome = yield* Review.run(
              input(test.directory, {
                model: selected,
                config: config({ security: "off" }),
                ...(pinned
                  ? {
                      identity: VECTORSCOPE_AGENT,
                      instructionsFromContext: true,
                      context: { instructions: "PINNED_BASE_INSTRUCTIONS_MARKER" },
                    }
                  : {}),
              }),
            )
            expect(outcome.specialists.map((pass) => pass.status)).toEqual(["ok"])
            const requests = yield* modelRequests(llm)
            expect(requests).toHaveLength(1)
            const body = requests[0]!
            expect(Array.isArray(body.input)).toBe(true)
            if (!pinned) {
              expect(body.instructions).toBe(
                variant ? "AMBIENT_RESPONSES_VARIANT_MARKER" : "AMBIENT_RESPONSES_MODEL_MARKER",
              )
              expect(body.truncation).toBe("auto")
              expect(body.conversation).toBe(variant ? undefined : "conv_ambient_model")
              expect(body.previous_response_id).toBe(variant ? "resp_ambient_variant" : undefined)
              continue
            }
            expect(body.instructions).toBeUndefined()
            expect(body.truncation).toBe("disabled")
            expect(body.conversation).toBeUndefined()
            expect(body.previous_response_id).toBeUndefined()
            expect(JSON.stringify(body.input)).toContain("You are VectorScope")
            expect(JSON.stringify(body.input)).toContain("PINNED_BASE_INSTRUCTIONS_MARKER")
            expect(JSON.stringify(body)).not.toContain("AMBIENT_RESPONSES_")
          }
        }),
      TIMEOUT,
    )

  it.instance(
    "VectorScope service uses its owner model and fixed factory when generic specialists are disabled",
    () =>
      Effect.gen(function* () {
        yield* ownerSettings({
          agent: {
            vectorscope: {
              model: "lmstudio/scope-model",
              variant: "high",
              prompt: "AMBIENT_SCOPE_GLOBAL_PROMPT_MARKER",
              options: { instructions: "AMBIENT_SCOPE_GLOBAL_OPTIONS_MARKER" },
            },
          },
        })
        const test = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const configured = testProviderConfig(llm.url)
        yield* fs.writeWithDirs(
          path.join(test.directory, "vector.json"),
          JSON.stringify({
            ...configured,
            provider: {
              lmstudio: {
                ...configured.provider.lmstudio,
                models: {
                  ...configured.provider.lmstudio.models,
                  "scope-model": {
                    ...configured.provider.lmstudio.models["test-model"],
                    id: "scope-model",
                    variants: { high: { reasoningEffort: "high" } },
                  },
                },
              },
            },
            agent: {
              review: { disable: true, model: "lmstudio/test-model", prompt: "AMBIENT_SCOPE_GENERIC_REVIEW_MARKER" },
              security: { disable: true, prompt: "AMBIENT_SCOPE_GENERIC_SECURITY_MARKER" },
              vectorscope: {
                model: "lmstudio/test-model",
                variant: "AMBIENT_SCOPE_PROJECT_VARIANT_MARKER",
                prompt: "AMBIENT_SCOPE_PROJECT_PROMPT_MARKER",
                options: { instructions: "AMBIENT_SCOPE_PROJECT_OPTIONS_MARKER" },
                mode: "all",
                hidden: false,
              },
            },
          }),
        )
        yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
        yield* Effect.promise(() => trustWorkspace(test.directory))
        const agents = yield* Agent.Service
        expect(yield* agents.get(VECTORSCOPE_AGENT)).toBeUndefined()
        expect(yield* agents.get("review")).toBeUndefined()
        expect(yield* agents.get("security")).toBeUndefined()
        expect((yield* agents.list()).map((agent) => agent.name)).not.toContain(VECTORSCOPE_AGENT)
        const helper = yield* agents.helper(VECTORSCOPE_AGENT, { reviewedPrompt: true })
        expect(helper.options).toEqual({})
        expect(helper.model).toBeUndefined()
        expect(helper.variant).toBeUndefined()
        for (const explicit of [false, true]) {
          yield* llm.reset
          const model = yield* resolveReviewModel({
            trigger: "local",
            identity: VECTORSCOPE_AGENT,
            ...(explicit ? { flag: "lmstudio/scope-model" } : {}),
          })
          expect(model.modelID).toBe(ModelV2.ID.make("scope-model"))
          expect(model.variant).toBe(explicit ? undefined : "high")
          yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([])))
          yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report([])))
          const outcome = yield* Review.run(
            input(test.directory, {
              identity: VECTORSCOPE_AGENT,
              instructionsFromContext: true,
              context: { instructions: "PINNED_BASE_INSTRUCTIONS_MARKER" },
              config: config({ security: "always" }),
              model,
            }),
          )
          expect(outcome.specialists.map((pass) => pass.status)).toEqual(["ok", "ok"])
          const bodies = yield* modelRequests(llm)
          expect(bodies).toHaveLength(2)
          for (const body of bodies) {
            expect(body.model).toBe("scope-model")
            expect(JSON.stringify(body)).toContain("You are VectorScope")
            expect(JSON.stringify(body)).toContain("PINNED_BASE_INSTRUCTIONS_MARKER")
            expect(JSON.stringify(body)).not.toContain("AMBIENT_SCOPE_")
          }
          const sessions = yield* Session.Service
          for (const id of outcome.sessions) {
            const sessionID = SessionID.make(id)
            expect((yield* sessions.get(sessionID)).internal?.startsWith(PINNED_SESSION_PREFIX)).toBe(true)
            const messages = yield* sessions.messages({ sessionID })
            const user = messages.find((message) => message.info.role === "user")?.info
            expect(user?.role === "user" && user.model.variant).toBe(explicit ? undefined : "high")
            expect(
              messages
                .filter((message) => message.info.role === "assistant")
                .every((message) => message.info.agent === VECTORSCOPE_AGENT),
            ).toBe(true)
          }
        }
      }),
    TIMEOUT,
  )

  for (const project of [false, true])
    it.instance(
      `provided context excludes ambient configured agent prompts from ${project ? "global and project" : "global"} settings while legacy review retains them`,
      () =>
        Effect.gen(function* () {
          yield* ownerSettings({
            agent: {
              review: { prompt: "AMBIENT_CONFIG_GLOBAL_REVIEW_MARKER" },
              security: { prompt: "AMBIENT_CONFIG_GLOBAL_SECURITY_MARKER" },
            },
          })
          const configuration = yield* Config.Service
          const global = yield* configuration.getGlobal()
          expect(global.agent?.review?.prompt).toBe("AMBIENT_CONFIG_GLOBAL_REVIEW_MARKER")
          expect(global.agent?.security?.prompt).toBe("AMBIENT_CONFIG_GLOBAL_SECURITY_MARKER")
          const { llm, directory } = yield* useServer(
            undefined,
            project ? { agent: { review: { prompt: "AMBIENT_CONFIG_PROJECT_REVIEW_MARKER" } } } : {},
          )
          const agents = yield* Agent.Service
          expect((yield* agents.helper("review")).prompt).toBe(
            project ? "AMBIENT_CONFIG_PROJECT_REVIEW_MARKER" : "AMBIENT_CONFIG_GLOBAL_REVIEW_MARKER",
          )
          expect((yield* agents.helper("security")).prompt).toBe("AMBIENT_CONFIG_GLOBAL_SECURITY_MARKER")
          yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([])))
          yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report([])))
          const legacy = yield* Review.run(input(directory, { config: config({ security: "always" }) }))
          expect(legacy.specialists.map((item) => item.status)).toEqual(["ok", "ok"])
          const legacyBodies = JSON.stringify(yield* modelRequests(llm))
          expect(legacyBodies).toContain(
            project ? "AMBIENT_CONFIG_PROJECT_REVIEW_MARKER" : "AMBIENT_CONFIG_GLOBAL_REVIEW_MARKER",
          )
          expect(legacyBodies).toContain("AMBIENT_CONFIG_GLOBAL_SECURITY_MARKER")

          yield* llm.reset
          yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([])))
          yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report([])))
          const pinned = yield* Review.run(
            input(directory, {
              config: config({ security: "always" }),
              instructionsFromContext: true,
              context: { instructions: "PINNED_BASE_INSTRUCTIONS_MARKER" },
            }),
          )
          expect(pinned.specialists.map((item) => item.status)).toEqual(["ok", "ok"])
          const bodies = yield* modelRequests(llm)
          expect(bodies).toHaveLength(2)
          for (const body of bodies) {
            expect(JSON.stringify(body)).toContain("PINNED_BASE_INSTRUCTIONS_MARKER")
            expect(JSON.stringify(body)).not.toContain("AMBIENT_CONFIG_")
          }
          const reviewed = JSON.stringify(bodies)
          expect(reviewed).toContain("You are a senior code review specialist.")
          expect(reviewed).toContain("You are a read-only application security specialist.")
          // A bound run must not replace the cached helper the next legacy run uses.
          yield* llm.reset
          yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([])))
          yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report([])))
          const subsequent = yield* Review.run(input(directory, { config: config({ security: "always" }) }))
          expect(subsequent.specialists.map((item) => item.status)).toEqual(["ok", "ok"])
          const subsequentBodies = JSON.stringify(yield* modelRequests(llm))
          expect(subsequentBodies).toContain(
            project ? "AMBIENT_CONFIG_PROJECT_REVIEW_MARKER" : "AMBIENT_CONFIG_GLOBAL_REVIEW_MARKER",
          )
          expect(subsequentBodies).toContain("AMBIENT_CONFIG_GLOBAL_SECURITY_MARKER")
        }),
      TIMEOUT,
    )

  for (const context of [272_000, 272_001, 300_000]) {
    it.instance(
      `reserves the exact context tier before a ${context}-token finalizer`,
      () =>
        Effect.gen(function* () {
          const { llm, directory } = yield* useServer({ input: 1, output: 1 }, { compaction: { auto: false } })
          const provider = yield* Provider.Service
          const catalogModel = yield* provider.getModel(ref.providerID, ref.modelID)
          // Inject catalog metadata into this fixture's instance, because project cost overrides expose only the
          // older over-200K band. Neither the request prompt nor the model's tool/effort configuration is inflated.
          Object.assign(catalogModel, {
            limit: { ...catalogModel.limit, context: 1_000_000 },
            cost: {
              input: 1,
              output: 1,
              cache: { read: 0, write: 0 },
              tiers: [{ tier: { type: "context", size: 272_000 }, input: 2, output: 1, cache: { read: 0, write: 0 } }],
            },
          })
          const selected = yield* resolveReviewModel({ trigger: "local", flag: "lmstudio/test-model", env: {} })
          const before = JSON.stringify(catalogModel)
          // Production predicts the next context as the preceding reported context plus 3K. The fake finalizer
          // reports exactly that prediction, so a failure cannot be attributed to unpredictable context growth.
          yield* llm.pushMatch(
            REVIEW,
            reply()
              .text("Investigation finished without a structured report.")
              .usage({ input: context - 3_000, output: 100 })
              .stop(),
          )
          yield* llm.pushMatch(
            FINALIZE,
            reply().tool("StructuredOutput", report()).usage({ input: context, output: 100 }),
          )
          const capped = context === 300_000 ? 1 : 0.7
          const firstRate = context - 3_000 > 272_000 ? 2 : 1
          const firstUsd = ((context - 3_000) * firstRate + 100) / 1_000_000
          const finalUsd = (context * (context > 272_000 ? 2 : 1) + 100) / 1_000_000
          const affordable = firstUsd + finalUsd <= capped
          const outcome = yield* Review.run(
            input(directory, { model: selected, config: config({ maxCostUsd: capped, security: "off" }) }),
          )
          const requests = yield* modelRequests(llm)
          expect(requests.every((request) => JSON.stringify(request).length < 100_000)).toBe(true)
          expect(JSON.stringify(catalogModel)).toBe(before)
          expect(outcome.cost?.costUsd).toBeCloseTo(
            firstUsd + (requests.some((body) => FINALIZE({ body })) ? finalUsd : 0),
            6,
          )
          // The boundary control is affordable at base rates. The other controls are unaffordable specifically at
          // their long-context rate, even though the old base-rate reservation permits them.
          expect(requests.filter((body) => FINALIZE({ body }))).toHaveLength(affordable ? 1 : 0)
          expect(outcome.cost?.costUsd).toBeLessThanOrEqual(capped)
        }),
      TIMEOUT,
    )
  }

  it.instance(
    "refuses an unaffordable initial request without starting the provider and keeps plan reviews uncapped",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const limited = input(directory, { model: priced, config: config({ maxCostUsd: 0.00001 }) })
        const stopped = yield* Review.run(limited)
        expect(yield* llm.hits).toHaveLength(0)
        expect(stopped.specialists).toEqual([{ name: "review", status: "stopped", steps: 0, detail: "budget" }])
        expect(stopped.partial).toBe("budget")
        expect(stopped.unreviewed).toEqual(["src/list.ts"])
        expect(stopped.cost).toMatchObject({ costUsd: 0, kind: "priced" })

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }))
        const plan = yield* Review.run({ ...limited, model: { ...priced, costKind: "plan" } })
        expect(plan.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
        expect(yield* llm.hits).toHaveLength(1)
      }),
    TIMEOUT,
  )

  it.instance(
    "reserves initial turns across specialists instead of admitting both against the same remainder",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const release = Promise.withResolvers<void>()
        yield* llm.push(
          reply().wait(release.promise).tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }),
        )
        const [outcome] = yield* Effect.all(
          [
            Review.run(
              input(directory, {
                model: priced,
                files: AUTH,
                anchors: AUTH,
                rules: "Check boundary conditions. ".repeat(1_000),
                config: config({ maxCostUsd: 0.35 }),
              }),
            ),
            llm.wait(1).pipe(Effect.tap(() => Effect.sync(() => release.resolve()))),
          ],
          { concurrency: 2 },
        ).pipe(Effect.ensuring(Effect.sync(() => release.resolve())))
        expect(yield* llm.hits).toHaveLength(1)
        expect(outcome.specialists.map((item) => item.status).toSorted()).toEqual(["ok", "stopped"])
        expect(outcome.specialists.find((item) => item.status === "stopped")).toMatchObject({
          steps: 0,
          detail: "budget",
        })
        expect(outcome.partial).toBe("budget")
        expect(outcome.unreviewed).toEqual(["src/auth/session.ts"])
      }),
    TIMEOUT,
  )

  it.instance(
    "keeps affordable initial requests parallel and reserves a running finalizer against the other specialist",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const review = Promise.withResolvers<void>()
        const security = Promise.withResolvers<void>()
        const finalize = Promise.withResolvers<void>()
        const stopped = Promise.withResolvers<void>()
        const costs: number[] = []
        const read = { filePath: path.join(directory, "src/list.ts") }
        yield* llm.pushMatch(
          REVIEW,
          reply().wait(review.promise).tool("read", read).usage({ input: 30_000, output: 100 }),
        )
        yield* llm.pushMatch(
          SECURITY,
          reply().wait(security.promise).tool("read", read).usage({ input: 30_000, output: 100 }),
        )
        yield* llm.pushMatch(
          FINALIZE,
          reply().wait(finalize.promise).tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }),
        )
        const [outcome] = yield* Effect.all(
          [
            Review.run(
              input(directory, {
                model: priced,
                files: AUTH,
                anchors: AUTH,
                config: config({ maxCostUsd: 1 }),
                onProgress(event) {
                  if (event.type === "cost") costs.push(event.costUsd)
                  if (event.type === "specialist" && event.name === "security" && event.status === "stopped")
                    stopped.resolve()
                },
              }),
            ),
            Effect.gen(function* () {
              // Both requests must start before either response is released.
              yield* llm.wait(2)
              review.resolve()
              yield* llm.wait(3)
              expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(1)
              security.resolve()
              yield* Effect.promise(() => stopped.promise)
              finalize.resolve()
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.timeout("20 seconds"),
          Effect.ensuring(
            Effect.sync(() => {
              review.resolve()
              security.resolve()
              finalize.resolve()
            }),
          ),
        )
        expect(yield* llm.hits).toHaveLength(3)
        expect(outcome.specialists).toEqual([
          { name: "review", status: "stopped", steps: 2, detail: "budget" },
          { name: "security", status: "stopped", steps: 1, detail: "budget" },
        ])
        expect(outcome.cost?.costUsd).toBeCloseTo(0.613, 6)
        expect(costs).toEqual([...costs].sort((a, b) => a - b))
        expect(costs.at(-1)).toBeCloseTo(0.613, 6)
        expect(outcome.partial).toBe("budget")
      }),
    TIMEOUT,
  )

  it.instance(
    "blocks sibling admission using already observed excess before the expensive stream finishes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const events = yield* EventV2Bridge.Service
        const review = Promise.withResolvers<void>()
        const security = Promise.withResolvers<void>()
        const observed = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const stopped = Promise.withResolvers<void>()
        const off = yield* events.listen((event) => {
          if (event.type !== SessionV1.Event.PartUpdated.type) return Effect.void
          const part = (event.data as typeof SessionV1.Event.PartUpdated.data.Type).part
          if (part.type !== "step-finish" || part.cost <= 0.4) return Effect.void
          observed.resolve()
          // Hold before Review's listener and before the processor can finish its snapshot/stream. Admission must
          // already include this known charge, even though terminal lease settlement has not happened yet.
          return Effect.promise(() => release.promise)
        })
        const unlock = Effect.sync(() => {
          review.resolve()
          security.resolve()
          release.resolve()
        })
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .wait(review.promise)
            .tool("read", { filePath: path.join(directory, "src/list.ts") })
            .usage({ input: 40_000, output: 100 }),
        )
        yield* llm.pushMatch(
          SECURITY,
          reply()
            .wait(security.promise)
            .tool("read", { filePath: path.join(directory, "src/list.ts") })
            .usage({ input: 1_000, output: 100 }),
        )
        const [outcome] = yield* Effect.all(
          [
            Review.run(
              input(directory, {
                model: priced,
                config: config({ maxCostUsd: 0.4, security: "always" }),
                onProgress(event) {
                  if (event.type === "specialist" && event.name === "security" && event.status === "stopped")
                    stopped.resolve()
                },
              }),
            ),
            Effect.gen(function* () {
              yield* llm.wait(2)
              review.resolve()
              yield* Effect.promise(() => observed.promise)
              security.resolve()
              const next = yield* Effect.raceFirst(
                Effect.promise(() => stopped.promise).pipe(Effect.as("stopped")),
                llm.wait(3).pipe(Effect.as("unexpected provider request")),
              )
              expect(next).toBe("stopped")
              release.resolve()
            }).pipe(Effect.ensuring(unlock)),
          ],
          { concurrency: 2 },
        ).pipe(Effect.timeout("20 seconds"), Effect.ensuring(unlock), Effect.ensuring(off))
        expect(yield* modelRequests(llm)).toHaveLength(2)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
        expect(outcome.specialists).toEqual([
          { name: "review", status: "stopped", steps: 1, detail: "budget" },
          { name: "security", status: "stopped", steps: 1, detail: "budget" },
        ])
        expect(outcome.cost?.costUsd).toBeCloseTo(0.412, 6)
        expect(outcome.partial).toBe("budget")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
      }),
    TIMEOUT,
  )

  it.instance(
    "settles output that exceeds its reservation without refunding it or starting an unaffordable finalizer",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("read", { filePath: path.join(directory, "src/list.ts") })
            .usage({ input: 40_000, output: 100 }),
        )
        const outcome = yield* Review.run(input(directory, { model: priced, config: config({ maxCostUsd: 0.8 }) }))
        expect(yield* llm.hits).toHaveLength(1)
        expect(outcome.specialists).toEqual([{ name: "review", status: "stopped", steps: 1, detail: "budget" }])
        expect(outcome.cost?.costUsd).toBeCloseTo(0.401, 6)
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
      }),
    TIMEOUT,
  )

  it.instance(
    "does not reuse a failed finalizer's unreported usage estimate for verification",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const reviewed = Promise.withResolvers<void>()
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding({ path: "src/auth/session.ts", line: 2 })]))
            .usage({ input: 1_000, output: 100 }),
        )
        yield* llm.pushMatch(
          SECURITY,
          reply()
            .wait(reviewed.promise)
            .tool("read", { filePath: path.join(directory, "src/list.ts") })
            .usage({ input: 25_000, output: 100 }),
        )
        yield* llm.pushMatch(FINALIZE, reply().text("The review could not be completed.").stop())
        const outcome = yield* Review.run(
          input(directory, {
            model: priced,
            files: AUTH,
            anchors: AUTH,
            config: config({ maxCostUsd: 0.58, verify: "blocking" }),
            onProgress(event) {
              if (event.type === "specialist" && event.name === "review" && event.status === "ok") reviewed.resolve()
            },
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => reviewed.resolve())))
        expect(outcome.specialists.map((item) => [item.name, item.status])).toEqual([
          ["review", "ok"],
          ["security", "failed"],
          ["verify", "skipped"],
        ])
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(0)
        expect(outcome.cost?.costUsd).toBeCloseTo(0.262, 6)
        expect(outcome.notes).toContain(
          "Reported cost may be incomplete; work with uncertain usage retained its estimated budget exposure for this review.",
        )
      }),
    TIMEOUT,
  )

  it.instance(
    "retains uncertain usage from a successful report but releases explicitly reported zero usage",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const review = input(directory, {
          model: priced,
          config: config({ maxCostUsd: 0.55, security: "always", verify: "blocking" }),
        })
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 0, output: 0 }),
        )
        yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()).usage({ input: 30_000, output: 100 }))
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", { results: [] }).usage({ input: 1_000, output: 100 }),
        )
        const known = yield* Review.run(review)
        expect(known.specialists.at(-1)).toMatchObject({ name: "verify", status: "ok" })
        expect(known.notes).toEqual([])

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()).usage({ input: 30_000, output: 100 }))
        const unknown = yield* Review.run(review)
        expect(unknown.specialists).toEqual([
          { name: "review", status: "ok", steps: 1 },
          { name: "security", status: "ok", steps: 1 },
          { name: "verify", status: "skipped", steps: 0, detail: "budget" },
        ])
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(1)
        expect(unknown.cost?.costUsd).toBeCloseTo(0.301, 6)
        expect(unknown.notes).toContain(
          "Reported cost may be incomplete; work with uncertain usage retained its estimated budget exposure for this review.",
        )
      }),
    TIMEOUT,
  )

  it.instance(
    "releases unused finalization reservations after both reports complete before admitting verification",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding({ path: "src/auth/session.ts", line: 2 })]))
            .usage({ input: 30_000, output: 100 }),
        )
        yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()).usage({ input: 30_000, output: 100 }))
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", { results: [] }).usage({ input: 1_000, output: 100 }),
        )
        const outcome = yield* Review.run(
          input(directory, {
            model: priced,
            files: AUTH,
            anchors: AUTH,
            config: config({ maxCostUsd: 1, verify: "blocking" }),
          }),
        )
        expect(outcome.specialists.map((item) => [item.name, item.status])).toEqual([
          ["review", "ok"],
          ["security", "ok"],
          ["verify", "ok"],
        ])
        expect(yield* llm.hits).toHaveLength(3)
        expect(outcome.cost?.costUsd).toBeCloseTo(0.613, 6)
        expect(outcome.notes).toEqual([])
      }),
    TIMEOUT,
  )

  it.instance(
    "keeps findings that clear the bar and drops the rest, with no shell in any request",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(
          REVIEW,
          reply().tool(
            "StructuredOutput",
            report([
              finding(),
              finding({ line: 1, title: "A hunch", confidence: 0.3 }),
              finding({ path: "bun.lock", line: 1, title: "Lockfile drift" }),
              finding({ path: "src/missing.ts", line: 4, title: "A file that does not exist" }),
              finding({ path: "src/other.ts", line: 10, severity: "concern", title: "A caller expects the old value" }),
            ]),
          ),
        )

        const outcome = yield* Review.run(
          input(directory, {
            skipped: [{ path: "bun.lock", reason: "lockfile" }],
            knownPath: async (file) => file === "src/other.ts",
          }),
        )

        expect(outcome.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
        expect(outcome.selection.inline.map((item) => [item.path, item.anchor.line, item.source])).toEqual([
          ["src/list.ts", 3, "review"],
        ])
        expect(outcome.selection.outsideDiff.map((item) => [item.path, item.reason])).toEqual([
          ["src/other.ts", "file-not-in-diff"],
        ])
        expect(outcome.selection.dropped).toEqual([
          { reason: "low-confidence", count: 1 },
          { reason: "ignored-path", count: 1 },
          { reason: "unknown-path", count: 1 },
        ])
        expect(outcome.selection.risk).toBe("high")
        expect(outcome.report.summary).toBe("Changes last() to index past the end.")
        expect(outcome.partial).toBeUndefined()
        expect(outcome.unreviewed).toEqual([])
        expect(outcome.cost?.kind).toBe("unknown")
        expect(outcome.cost?.usageMissing).toBe(true)
        expect(outcome.cost?.model).toBe("lmstudio/test-model")
        expect(outcome.sessions).toHaveLength(1)
        expect(outcome.stats).toEqual({ files: 1, additions: 2, deletions: 1 })
        const requests = yield* modelRequests(llm)
        expect(requests.length).toBeGreaterThan(0)
        for (const body of requests) {
          // The engine has no `list` tool today; the rules allow it for when it exists.
          expect(
            toolNames(body).filter((name) => !["StructuredOutput", "glob", "grep", "list", "read"].includes(name)),
          ).toEqual([])
          expect(toolNames(body)).toContain("StructuredOutput")
        }
      }),
    TIMEOUT,
  )

  it.instance(
    "stops before the next step would break the budget with a finalize reserved, then finalizes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const file = path.join(directory, "src/list.ts")
        // $0.201, then $0.301: after the second step the next step and a finalize ($0.336 each) no longer fit in $1.
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: file }).usage({ input: 20_000, output: 100 }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: file }).usage({ input: 30_000, output: 100 }))
        yield* llm.pushMatch(
          FINALIZE,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 30_000, output: 100 }),
        )

        const outcome = yield* Review.run(input(directory, { model: priced, config: config({ maxCostUsd: 1 }) }))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "stopped", detail: "budget" })
        expect(outcome.partial).toBe("budget")
        expect(outcome.report.findings).toHaveLength(1)
        expect(outcome.selection.inline).toHaveLength(1)
        // Every step is counted, the finalize included, and the total stays within the cap plus one step.
        expect(outcome.cost?.costUsd).toBeCloseTo(0.201 + 0.301 + 0.301, 6)
        expect(outcome.cost?.kind).toBe("priced")
        expect(outcome.cost?.usageMissing).toBeUndefined()
        expect(outcome.cost!.costUsd).toBeLessThanOrEqual(1 + 0.301)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(1)
      }),
    TIMEOUT,
  )

  it.instance(
    "stops at the step cap, then finalizes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const file = path.join(directory, "src/list.ts")
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: file }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: file }))
        yield* llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report([finding()])))

        const outcome = yield* Review.run(input(directory, { config: config({ maxSteps: 2 }) }))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "stopped", detail: "steps" })
        expect(outcome.partial).toBe("steps")
        expect(outcome.report.findings).toHaveLength(1)
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(2)
        expect((yield* llm.inputs).filter((body) => FINALIZE({ body })).map(toolNames)).toEqual([["StructuredOutput"]])
      }),
    TIMEOUT,
  )

  it.instance(
    "counts failed provider attempts before retries and allows only one finalizer attempt",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, httpError(503, { error: "temporary failure" }))
        yield* llm.pushMatch(FINALIZE, httpError(503, { error: "temporary finalizer failure" }))
        const outcome = yield* Review.run(input(directory, { config: config({ maxSteps: 1 }) }))
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(1)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(1)
        expect(outcome.specialists).toEqual([{ name: "review", status: "stopped", steps: 0, detail: "steps" }])
        expect(outcome.partial).toBe("steps")
        expect(outcome.unreviewed).toContain("src/list.ts")
        expect((yield* llm.inputs).filter((body) => FINALIZE({ body })).map(toolNames)).toEqual([["StructuredOutput"]])
      }),
    TIMEOUT,
  )

  it.instance(
    "denies compaction at the attempt boundary without looping or spending the finalizer on a summary",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, httpError(400, { type: "error", error: { code: "context_length_exceeded" } }))
        yield* llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report()))
        const outcome = yield* Review.run(input(directory, { config: config({ maxSteps: 1 }) }))
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(1)
        expect(yield* modelRequests(llm)).toHaveLength(1)
        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "stopped", detail: "steps" })
        expect(outcome.partial).toBe("steps")
        expect(outcome.unreviewed).toContain("src/list.ts")
        expect((yield* llm.inputs).filter((body) => FINALIZE({ body })).map(toolNames)).toEqual([])
      }),
    TIMEOUT,
  )

  it.instance(
    "keeps coverage incomplete when one specialist exhausts attempts without a report",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        yield* llm.pushMatch(SECURITY, httpError(503, { error: "temporary failure" }))
        yield* llm.pushMatch(FINALIZE, httpError(503, { error: "temporary finalizer failure" }))
        const outcome = yield* Review.run(input(directory, { config: config({ maxSteps: 1, security: "always" }) }))
        expect(outcome.specialists).toEqual([
          { name: "review", status: "ok", steps: 1 },
          { name: "security", status: "stopped", steps: 0, detail: "steps" },
        ])
        expect(yield* modelRequests(llm)).toHaveLength(3)
        expect(outcome.partial).toBe("steps")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
      }),
    TIMEOUT,
  )

  it.instance(
    "times out a hung model without hanging and finalizes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        // A first review loads the instance's config, providers and tools, so the short deadline below is spent
        // waiting on the hung model rather than racing a cold start that can end before the model is ever asked.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        expect((yield* Review.run(input(directory))).specialists[0]).toMatchObject({ name: "review", status: "ok" })
        yield* llm.pushMatch(REVIEW, reply().hang())
        yield* llm.pushMatch(
          FINALIZE,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 1_000, output: 100 }),
        )
        const started = Date.now()

        const outcome = yield* Review.run(input(directory, { model: priced, config: config({ timeoutMinutes: 0.02 }) }))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "timeout", detail: "timeout" })
        expect(outcome.partial).toBe("timeout")
        expect(outcome.report.findings).toHaveLength(1)
        expect(outcome.cost?.costUsd).toBeCloseTo(0.011, 6)
        // The deadline ended a request the model never answered: the warm-up review and the hung one.
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(2)
        expect(Date.now() - started).toBeLessThan(20_000)
      }),
    TIMEOUT,
  )

  it.instance(
    "the durable local runner preserves actual provider output and stops its factory without a finalizer",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* ownerSettings({ agent: { vectorscope: { model: "lmstudio/test-model" } } })
        const files = yield* FSUtil.Service
        const git = yield* Git.Service
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const status = yield* SessionStatus.Service
        const runGit = (args: string[]) =>
          git.run(args, { cwd: directory }).pipe(
            Effect.map((result) => {
              expect(result.exitCode).toBe(0)
              return result.text().trim()
            }),
          )
        yield* files.writeWithDirs(
          path.join(directory, ".vector/review.json"),
          JSON.stringify({ security: "off", verify: "off" }),
        )
        yield* files.writeWithDirs(
          path.join(directory, "src/list.ts"),
          "export function last(items: number[]) {\n  return items[items.length - 1]\n}\n",
        )
        yield* runGit(["add", "."])
        yield* runGit(["commit", "-m", "local review base"])
        const head = yield* runGit(["rev-parse", "HEAD"])
        yield* files.writeWithDirs(path.join(directory, "src/list.ts"), LIST_SOURCE)
        const settings = yield* Config.Service
        // Adding review.json changes the trust snapshot created by useServer.
        // Prove the real veto, then approve/reload the complete owned fixture;
        // never hide model refusal behind a synthetic resolver or fallback.
        expect((yield* settings.trust()).trusted).toBe(false)
        expect((yield* settings.get()).provider?.lmstudio).toBeUndefined()
        yield* settings.approve()
        yield* reloadInstance({ directory })
        expect((yield* settings.trust()).trusted).toBe(true)
        expect((yield* settings.get()).provider?.lmstudio?.options?.baseURL).toBe(llm.url)
        const provider = yield* Provider.Service
        expect((yield* provider.getModel(ref.providerID, ref.modelID)).id).toBe(ref.modelID)
        const parent = yield* sessions.create({ title: "Local review owner" }, "owner")
        const source = {
          sessionID: parent.id,
          directory,
          worktree: directory,
          permission: [{ permission: "*", pattern: "*", action: "allow" as const }],
        }
        const runs = yield* ReviewLocalRun.make({
          runReview: Review.run,
          resolveModel: (input: ResolveInput) =>
            Effect.gen(function* () {
              expect((yield* InstanceState.context).directory).toBe(directory)
              expect(input.identity).toBe(VECTORSCOPE_AGENT)
              expect((yield* settings.trust()).trusted).toBe(true)
              expect((yield* settings.get()).provider?.lmstudio?.options?.baseURL).toBe(llm.url)
              expect((yield* provider.getModel(ref.providerID, ref.modelID).pipe(Effect.orDie)).id).toBe(ref.modelID)
              return yield* resolveReviewModel(input)
            }),
        })
        const request = { requestID: "actual_provider_complete", target: { kind: "working-tree" as const, head } }
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 120, output: 30 }),
        )
        const started = yield* runs.start(request, source)
        yield* jobs.wait({ id: started.runID })
        const finished = yield* runs.get(parent.id, started.runID)
        expect(finished.error).toBeUndefined()
        expect(finished.status).toBe("completed")
        const result = JSON.parse(finished.artifact!.json)
        expect(result.outcome.selection.inline).toHaveLength(1)
        expect(result.outcome.cost.input).toBe(120)
        expect(result.outcome.cost.output).toBe(30)
        expect(result.outcome.sessions).toHaveLength(1)
        const helper = yield* sessions.get(SessionID.make(result.outcome.sessions[0]))
        expect(helper.parentID).toBe(started.runID)
        expect(helper.internal).toBe(`${PINNED_SESSION_PREFIX}review`)
        expect(yield* modelRequests(llm)).toHaveLength(1)
        expect((yield* runs.start(request, source)).runID).toBe(started.runID)
        expect(yield* modelRequests(llm)).toHaveLength(1)
        yield* llm.reset
        yield* llm.pushMatch(REVIEW, reply().hang())
        const running = yield* runs.start({ ...request, requestID: "actual_provider_stopped" }, source)
        yield* llm.wait(1)
        const stopped = yield* runs.stop(parent.id, running.runID)
        expect(stopped.status).toBe("cancelled")
        const partial = JSON.parse(stopped.artifact!.json)
        expect(partial.outcome.partial).toBe("timeout")
        expect(partial.verdict.verdict).toBe("incomplete")
        expect((yield* status.list()).size).toBe(0)
        expect(yield* modelRequests(llm)).toHaveLength(1)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
        expect((yield* runs.get(parent.id, started.runID)).artifact).toEqual(finished.artifact)
      }),
    { git: true },
    TIMEOUT,
  )

  it.instance(
    "completed deletion between attach and registration prevents late actual provider admission",
    () =>
      Effect.gen(function* () {
        const f = yield* localOwnerFixture
        const lifecycle = yield* ReviewLifecycle.Service
        const entered = yield* Deferred.make<SessionID>()
        const release = yield* Deferred.make<void>()
        let held = false
        const paused: ReviewLifecycle.Interface = {
          ...lifecycle,
          within: (parentID, runID) => (effect) =>
            Effect.gen(function* () {
              if (runID && !held) {
                held = true
                yield* Deferred.succeed(entered, runID)
                yield* Deferred.await(release)
              }
              return yield* lifecycle.within(parentID, runID)(effect)
            }),
        }
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const runs = yield* ReviewLocalRun.make({ runReview: Review.run, resolveModel: resolveReviewModel }).pipe(
          Effect.provideService(ReviewLifecycle.Service, paused),
        )
        const starting = yield* runs.start(f.request, f.source).pipe(Effect.result, Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(entered), "Review did not attach before the deletion probe")
        yield* f.sessions.remove(f.parent.id)
        expect(Exit.isFailure(yield* f.sessions.get(f.parent.id).pipe(Effect.exit))).toBe(true)
        expect(yield* modelRequests(f.llm)).toHaveLength(0)
        yield* Deferred.succeed(release, undefined)
        const result = yield* awaitWithTimeout(Fiber.join(starting), "Late admission did not refuse the deleted parent")
        expect(Result.isFailure(result)).toBe(true)
        expect(yield* modelRequests(f.llm)).toHaveLength(0)
      }),
    { git: true },
    TIMEOUT,
  )

  it.instance(
    "deletion cancels a registered dormant review before its latch can admit an actual provider",
    () =>
      Effect.gen(function* () {
        const f = yield* localOwnerFixture
        const lifecycle = yield* ReviewLifecycle.Service
        const jobs = yield* BackgroundJob.Service
        const entered = yield* Deferred.make<SessionID>()
        const release = yield* Deferred.make<void>()
        let sections = 0
        const paused: ReviewLifecycle.Interface = {
          ...lifecycle,
          within: (parentID, runID) => (effect) =>
            Effect.gen(function* () {
              if (runID && ++sections === 2) {
                yield* Deferred.succeed(entered, runID)
                yield* Deferred.await(release)
              }
              return yield* lifecycle.within(parentID, runID)(effect)
            }),
        }
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const runs = yield* ReviewLocalRun.make({ runReview: Review.run, resolveModel: resolveReviewModel }).pipe(
          Effect.provideService(ReviewLifecycle.Service, paused),
        )
        const starting = yield* runs.start(f.request, f.source).pipe(Effect.result, Effect.forkChild)
        const runID = yield* awaitWithTimeout(Deferred.await(entered), "Dormant job was not registered")
        expect((yield* jobs.get(runID))?.status).toBe("running")
        yield* f.sessions.remove(f.parent.id)
        expect((yield* jobs.get(runID))?.status).toBe("cancelled")
        expect(Exit.isFailure(yield* f.sessions.get(f.parent.id).pipe(Effect.exit))).toBe(true)
        yield* Deferred.succeed(release, undefined)
        expect(Result.isFailure(yield* awaitWithTimeout(Fiber.join(starting), "Cancelled latch did not drain"))).toBe(
          true,
        )
        expect(yield* modelRequests(f.llm)).toHaveLength(0)
      }),
    { git: true },
    TIMEOUT,
  )

  it.instance(
    "deletion without instance context joins the actual provider and refuses reentrant review finalizer deletion",
    () =>
      Effect.gen(function* () {
        const f = yield* localOwnerFixture
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let deleted = false
        let finalizerBusy = false
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
        const runs = yield* ReviewLocalRun.make({
          resolveModel: resolveReviewModel,
          runReview: (input) =>
            Review.run(input).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  const nested = yield* f.sessions.remove(f.parent.id).pipe(Effect.result)
                  finalizerBusy = Result.isFailure(nested) && nested.failure._tag === "SessionBusyError"
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                }),
              ),
            ),
        })
        yield* f.llm.pushMatch(REVIEW, reply().hang())
        const started = yield* runs.start(f.request, f.source)
        yield* f.llm.wait(1)
        const removing = yield* f.sessions.remove(f.parent.id).pipe(
          Effect.provideService(InstanceRef, undefined),
          Effect.tap(() =>
            Effect.sync(() => {
              deleted = true
            }),
          ),
          Effect.forkChild,
        )
        yield* awaitWithTimeout(Deferred.await(entered), "Provider cancellation finalizer did not run")
        expect(finalizerBusy).toBe(true)
        expect(deleted).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* awaitWithTimeout(Fiber.join(removing), "Deletion did not join the provider's finalizer")
        expect(deleted).toBe(true)
        expect((yield* (yield* BackgroundJob.Service).get(started.runID))?.status).toBe("cancelled")
        expect(Exit.isFailure(yield* f.sessions.get(f.parent.id).pipe(Effect.exit))).toBe(true)
        expect(yield* modelRequests(f.llm)).toHaveLength(1)
        expect((yield* f.llm.hits).filter(FINALIZE)).toHaveLength(0)
      }),
    { git: true },
    TIMEOUT,
  )

  it.instance(
    "VectorScope service cancellation stops admission and its active factory without a finalizer",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const status = yield* SessionStatus.Service
        const alreadyStopped = new AbortController()
        alreadyStopped.abort()
        const scope = {
          identity: VECTORSCOPE_AGENT,
          instructionsFromContext: true as const,
          context: { instructions: "PINNED_BASE_INSTRUCTIONS_MARKER" },
        } as const
        const stopped = yield* Review.run(input(directory, { ...scope, stopSignal: alreadyStopped.signal }))
        expect(yield* modelRequests(llm)).toHaveLength(0)
        expect(stopped.unreviewed).toEqual(["src/list.ts"])
        const controller = new AbortController()
        yield* llm.pushMatch(REVIEW, reply().hang())
        const running = yield* Review.run(input(directory, { ...scope, stopSignal: controller.signal })).pipe(
          Effect.forkChild,
        )
        yield* llm.wait(1)
        controller.abort()
        const outcome = yield* Fiber.join(running)
        expect((yield* status.list()).size).toBe(0)
        expect(outcome.partial).toBe("timeout")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
        expect(yield* modelRequests(llm)).toHaveLength(1)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
      }),
    TIMEOUT,
  )

  it.instance(
    "a cloud stop denies an initial request without starting a specialist or finalizer",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const controller = new AbortController()
        controller.abort()
        const outcome = yield* Review.run(input(directory, { stopSignal: controller.signal, checks: false }))
        expect(yield* modelRequests(llm)).toEqual([])
        expect(outcome.partial).toBe("timeout")
        expect(outcome.specialists).toEqual([{ name: "review", status: "stopped", steps: 0, detail: "timeout" }])
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
      }),
    TIMEOUT,
  )

  it.instance(
    "a cloud stop cancels an in-flight specialist and starts no finalizer or follow-up model call",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const status = yield* SessionStatus.Service
        const controller = new AbortController()
        yield* llm.pushMatch(REVIEW, reply().hang())
        const fiber = yield* Review.run(input(directory, { stopSignal: controller.signal, checks: false })).pipe(
          Effect.forkChild,
        )
        yield* llm.wait(1)
        controller.abort()
        const outcome = yield* Fiber.join(fiber)
        expect((yield* status.list()).size).toBe(0)
        expect(outcome.partial).toBe("timeout")
        expect(outcome.selection.inline).toEqual([])
        expect(yield* modelRequests(llm)).toHaveLength(1)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
      }),
    TIMEOUT,
  )

  it.instance(
    "cancels the owned runner before releasing an externally interrupted review",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const status = yield* SessionStatus.Service
        yield* llm.pushMatch(REVIEW, reply().hang())
        const fiber = yield* Review.run(input(directory, { model: priced })).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* Fiber.interrupt(fiber)
        expect((yield* status.list()).size).toBe(0)
        expect(yield* modelRequests(llm)).toHaveLength(1)
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()).usage({ input: 10, output: 1 }))
        const outcome = yield* Review.run(input(directory, { model: priced }))
        expect(outcome.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
        expect(yield* modelRequests(llm)).toHaveLength(2)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
      }),
    TIMEOUT,
  )

  // Interrupting the first prompt on an instance while its config and providers are still loading must not leave
  // the interruption cached (the per-instance ScopedCache, and the global config and model catalog loaders).
  it.instance(
    "a review after an interrupted cold start still reaches the model",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        // A 5 ms deadline ends the first review while the instance is still loading.
        yield* Review.run(input(directory, { config: config({ timeoutMinutes: 5 / 60_000 }) }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "ok" })
        expect((yield* llm.hits).filter(REVIEW).length).toBeGreaterThan(0)
      }),
    TIMEOUT,
  )

  it.instance(
    "falls back to JSON in the reply text",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .text("Here is the review.\n```json\n" + JSON.stringify(report([finding()])) + "\n```")
            .stop(),
        )

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "ok" })
        expect(outcome.selection.inline).toHaveLength(1)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
      }),
    TIMEOUT,
  )

  it.instance(
    "runs the security reviewer only when a sensitive path changed",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        const plain = yield* Review.run(input(directory))
        expect(plain.specialists.map((entry) => entry.name)).toEqual(["review"])
        expect((yield* llm.hits).filter(SECURITY)).toHaveLength(0)

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        yield* llm.pushMatch(
          SECURITY,
          reply().tool(
            "StructuredOutput",
            report(
              [
                finding({
                  path: "src/auth/session.ts",
                  line: 2,
                  category: "security",
                  title: "The token is no longer verified",
                }),
              ],
              "",
            ),
          ),
        )
        const sensitive = yield* Review.run(input(directory, { files: AUTH, anchors: AUTH }))

        expect(sensitive.specialists.map((entry) => entry.name).toSorted()).toEqual(["review", "security"])
        expect(sensitive.sessions).toHaveLength(2)
        expect(sensitive.selection.inline.map((item) => [item.path, item.source])).toEqual([
          ["src/auth/session.ts", "security"],
        ])
        expect(sensitive.report.summary).toBe("Changes last() to index past the end.")
      }),
    TIMEOUT,
  )

  it.instance(
    "drops findings the verify pass rejects, marks confirmed ones, and counts verify in the cost",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const kept = finding()
        const rejected = finding({ line: 2, title: "The index variable shadows nothing", confidence: 0.95 })
        const [keptID, rejectedID] = Review.normalizeFindings([kept, rejected], "review", LIST).map((item) => item.id)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([kept, rejected]))
            .usage({ input: 1_000, output: 10 }),
        )
        yield* llm.pushMatch(
          VERIFY,
          reply()
            .tool("StructuredOutput", {
              results: [
                { id: keptID, verdict: "confirmed", reason: "Reproduced with a one-item array." },
                { id: rejectedID, verdict: "rejected", reason: "Not a defect." },
              ],
            })
            .usage({ input: 2_000, output: 20 }),
        )

        const outcome = yield* Review.run(
          input(directory, { model: priced, config: config({ verify: "blocking", maxCostUsd: 100 }) }),
        )

        expect(outcome.specialists.map((entry) => [entry.name, entry.status])).toEqual([
          ["review", "ok"],
          ["verify", "ok"],
        ])
        expect(outcome.selection.inline.map((item) => [item.id, item.verified])).toEqual([[keptID, true]])
        expect(outcome.selection.dropped).toEqual([{ reason: "rejected-by-verify", count: 1 }])
        expect(outcome.cost?.costUsd).toBeCloseTo(((1_000 + 10) * 10 + (2_000 + 20) * 10) / 1_000_000, 8)
      }),
    TIMEOUT,
  )

  it.instance(
    "skips verify when the budget is too low for it, and says so",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 50_000, output: 100 }),
        )

        const outcome = yield* Review.run(
          input(directory, { model: priced, config: config({ verify: "blocking", maxCostUsd: 0.6 }) }),
        )

        expect(outcome.specialists).toEqual([
          { name: "review", status: "ok", steps: 1 },
          { name: "verify", status: "skipped", steps: 0, detail: "budget" },
        ])
        expect(outcome.partial).toBeUndefined()
        expect(outcome.notes).toEqual([noteVerifySkipped()])
        expect(outcome.selection.inline).toHaveLength(1)
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(0)
      }),
    TIMEOUT,
  )

  it.instance(
    "checkpoints the spend after each session",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding({ path: "src/auth/session.ts", line: 2 })]))
            .usage({ input: 1_000, output: 100 }),
        )
        yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }))
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", { results: [] }).usage({ input: 1_000, output: 100 }),
        )
        const saved: ReviewCost[] = []

        const outcome = yield* Review.run(
          input(directory, {
            files: AUTH,
            anchors: AUTH,
            config: config({ verify: "blocking" }),
            onCheckpoint: async (spent) => {
              saved.push(spent)
            },
          }),
        )

        expect(outcome.sessions).toHaveLength(3)
        expect(saved).toHaveLength(3)
        expect(saved.every((spent) => spent.kind === "priced" && spent.model === "lmstudio/test-model")).toBe(true)
        expect(saved.every((spent) => spent.costUsd > 0)).toBe(true)
        // The review's sessions are helpers: marked, kept with their spend, and out of the session list.
        const sessions = yield* Session.Service
        const reviewed = yield* Effect.forEach(outcome.sessions, (id) => sessions.get(SessionID.make(id)))
        expect(reviewed.map((session) => session.internal)).toEqual([
          "vectorscope.review",
          "vectorscope.security",
          "vectorscope.verify",
        ])
        const listed = (yield* sessions.list({ limit: 50 })).map((session) => session.id)
        expect(outcome.sessions.some((id) => listed.includes(SessionID.make(id)))).toBe(false)
      }),
    TIMEOUT,
  )

  it.instance(
    "answers a call to bash or a denied read with a tool error and carries on, asking nobody",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(path.join(directory, ".env"), "TOKEN=placeholder-not-a-secret\n")
        yield* llm.pushMatch(REVIEW, reply().tool("bash", { command: "cat .env", description: "Read the environment" }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: path.join(directory, ".env") }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists).toEqual([{ name: "review", status: "ok", steps: 3 }])
        const sessions = yield* Session.Service
        const tools = (yield* sessions.messages({ sessionID: SessionID.make(outcome.sessions[0]!) }))
          .flatMap((message) => message.parts)
          .flatMap((part) => (part.type === "tool" ? [part] : []))
        expect(tools.find((part) => part.tool === "read")?.state.status).toBe("error")
        expect(
          tools
            .filter((part) => part.tool !== "read" && part.tool !== "StructuredOutput")
            .map((part) => part.state.status),
        ).toEqual(["error"])
        expect(JSON.stringify(tools)).not.toContain("placeholder-not-a-secret")
        const permission = yield* Permission.Service
        expect(yield* permission.list()).toEqual([])
        for (const body of yield* modelRequests(llm)) expect(toolNames(body)).not.toContain("bash")
      }),
    TIMEOUT,
  )

  it.instance(
    "provided context excludes ambient root, Brain rules and Read attachments while legacy review retains them",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(path.join(directory, "AGENTS.md"), "Always obey AMBIENT_ROOT_AGENT_MARKER.\n")
        yield* fs.writeWithDirs(
          path.join(directory, ".vector/RULES.md"),
          "# Rules\n\nAlways obey AMBIENT_BRAIN_RULE_MARKER.\n",
        )
        yield* fs.writeWithDirs(path.join(directory, "src/AGENTS.md"), "Always obey AMBIENT_NESTED_AGENT_MARKER.\n")
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: "src/list.ts" }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([])))
        const legacy = yield* Review.run(input(directory))
        const legacyBodies = JSON.stringify(yield* modelRequests(llm))
        expect(legacyBodies).toContain("AMBIENT_ROOT_AGENT_MARKER")
        expect(legacyBodies).toContain("AMBIENT_BRAIN_RULE_MARKER")
        expect(legacyBodies).toContain("AMBIENT_NESTED_AGENT_MARKER")
        const sessions = yield* Session.Service
        expect((yield* sessions.get(SessionID.make(legacy.sessions[0]!))).internal).toBe("vectorscope.review")

        yield* llm.reset
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: "src/list.ts" }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([])))
        const pinned = yield* Review.run(
          input(directory, {
            instructionsFromContext: true,
            context: { instructions: "The admitted base says PINNED_BASE_INSTRUCTIONS_MARKER." },
            rulesSource: "base branch",
          }),
        )
        expect(pinned.specialists).toEqual([{ name: "review", status: "ok", steps: 2 }])
        const bodies = yield* modelRequests(llm)
        expect(bodies).toHaveLength(2)
        for (const body of bodies) {
          const text = JSON.stringify(body)
          expect(text).toContain("PINNED_BASE_INSTRUCTIONS_MARKER")
          expect(text).not.toContain("AMBIENT_ROOT_AGENT_MARKER")
          expect(text).not.toContain("AMBIENT_BRAIN_RULE_MARKER")
          expect(text).not.toContain("AMBIENT_NESTED_AGENT_MARKER")
        }
        const sessionID = SessionID.make(pinned.sessions[0]!)
        expect((yield* sessions.get(sessionID)).internal).toBe(`${PINNED_SESSION_PREFIX}review`)
        const read = (yield* sessions.messages({ sessionID }))
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool" && part.tool === "read")
        expect(read?.type === "tool" && read.state.status).toBe("completed")
        if (read?.type === "tool" && read.state.status === "completed") expect(read.state.metadata.loaded).toEqual([])
      }),
    TIMEOUT,
  )

  it.instance(
    "a provided-context review refuses compaction before another provider or finalizer call",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, httpError(400, { type: "error", error: { code: "context_length_exceeded" } }))
        const outcome = yield* Review.run(
          input(directory, {
            instructionsFromContext: true,
            context: { instructions: "PINNED_BASE_INSTRUCTIONS_MARKER" },
          }),
        )
        expect(yield* modelRequests(llm)).toHaveLength(1)
        expect(outcome.specialists[0]).toMatchObject({
          name: "review",
          status: "failed",
          detail:
            "Review incomplete: Compaction would discard the provided review context. Start a fresh review with the pinned context.",
        })
        expect(outcome.unreviewed).toContain("src/list.ts")
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
      }),
    TIMEOUT,
  )

  it.instance(
    "the durable provided-context session identity refuses missing scope metadata",
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServer()
        const sessions = yield* Session.Service
        const prompts = yield* SessionPrompt.Service
        const session = yield* sessions.create({
          title: "Provided-context review after metadata loss",
          internal: `${PINNED_SESSION_PREFIX}review`,
          permission: reviewPermissionRules({}),
        })
        const result = yield* prompts
          .prompt({
            sessionID: session.id,
            agent: "review",
            model: { providerID: ref.providerID, modelID: ref.modelID },
            parts: [{ type: "text", text: "The original provided-context metadata is no longer present." }],
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toBeInstanceOf(SessionPrompt.ReviewContextUnavailable)
        expect(yield* modelRequests(llm)).toHaveLength(0)
        expect((yield* sessions.get(session.id)).internal).toBe(`${PINNED_SESSION_PREFIX}review`)
      }),
    TIMEOUT,
  )

  it.instance(
    "nested service placement roots relative denials in the actual tool worktree",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const files = yield* FSUtil.Service
        const git = yield* Git.Service
        const runGit = (args: string[]) =>
          git.run(args, { cwd: directory }).pipe(
            Effect.tap((result) => Effect.sync(() => expect(result.exitCode).toBe(0))),
            Effect.map((result) => result.text().trim()),
          )
        const privateFile = path.join(directory, "private/sensitive.txt")
        const nested = path.join(directory, "nested")
        yield* files.writeWithDirs(privateFile, "original\n")
        yield* files.writeWithDirs(path.join(nested, "private/sensitive.txt"), "VISIBLE_NESTED_DECOY\n")
        yield* runGit(["add", "."])
        yield* runGit(["commit", "-m", "review base"])
        const base = yield* runGit(["rev-parse", "HEAD"])
        yield* files.writeWithDirs(privateFile, "WITHHELD_NESTED_SERVICE\n")
        yield* files.writeWithDirs(path.join(directory, "src/list.ts"), `${LIST_SOURCE}\n// visible change\n`)
        yield* runGit(["add", "."])
        yield* runGit(["commit", "-m", "review changes"])
        const head = yield* runGit(["rev-parse", "HEAD"])
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: "private/sensitive.txt" }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: "nested/private/sensitive.txt" }))
        yield* llm.pushMatch(REVIEW, reply().tool("glob", { pattern: "*", path: path.dirname(privateFile) }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: path.dirname(privateFile) }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([])))
        const result = yield* ReviewService.execute(
          {
            version: 1,
            mode: "review",
            directory: nested,
            target: { kind: "branch", base, head },
            settingsRef: base,
            model: "lmstudio/test-model",
            readDenies: ["private/*"],
          },
          {
            resolveModel: resolveReviewModel,
            runReview: Review.run,
            confirm: async () => false,
            stdout: async () => {},
            stderr: () => {},
            posting: async () => {
              throw new Error("The stateless review cannot post")
            },
          },
        )
        expect(result.exitCode).toBe(0)
        expect(result.verdict.verdict).toBe("incomplete")
        expect(result.outcome?.unreviewed).toContain("private/sensitive.txt")
        expect(result.outcome?.sessions).toHaveLength(1)
        const sessions = yield* Session.Service
        const tools = (yield* sessions.messages({ sessionID: SessionID.make(result.outcome!.sessions[0]!) }))
          .flatMap((message) => message.parts)
          .flatMap((part) => (part.type === "tool" && part.tool !== "StructuredOutput" ? [part] : []))
        expect(tools.map((part) => part.state.status)).toEqual(["error", "completed", "completed", "completed"])
        expect(JSON.stringify(tools)).toContain("VISIBLE_NESTED_DECOY")
        for (const part of tools.slice(2))
          if (part.state.status === "completed") expect(part.state.output).not.toContain("sensitive.txt")
        expect(JSON.stringify(yield* modelRequests(llm))).not.toContain("WITHHELD_NESTED_SERVICE")
      }),
    { git: true },
    TIMEOUT,
  )

  it.instance(
    "a resolver-time symlink retarget cannot release the admitted canonical read denial",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const files = yield* FSUtil.Service
        const git = yield* Git.Service
        const runGit = (args: string[]) =>
          git.run(args, { cwd: directory }).pipe(
            Effect.tap((result) => Effect.sync(() => expect(result.exitCode).toBe(0))),
            Effect.map((result) => result.text().trim()),
          )
        const secretA = path.join(directory, "secret-a/sensitive.txt")
        const secretB = path.join(directory, "secret-b/sensitive.txt")
        const link = path.join(directory, "secret-link")
        yield* files.writeWithDirs(secretA, "original-a\n")
        yield* files.writeWithDirs(secretB, "WITHHELD_RETARGET_B\n")
        yield* runGit(["add", "."])
        yield* runGit(["commit", "-m", "review base"])
        const base = yield* runGit(["rev-parse", "HEAD"])
        yield* files.writeWithDirs(secretA, "WITHHELD_ADMITTED_CANONICAL_A\n")
        yield* files.writeWithDirs(path.join(directory, "src/list.ts"), `${LIST_SOURCE}\n// visible change\n`)
        yield* runGit(["add", "."])
        yield* runGit(["commit", "-m", "review changes"])
        const head = yield* runGit(["rev-parse", "HEAD"])
        yield* Effect.promise(() =>
          fs.symlink(path.dirname(secretA), link, process.platform === "win32" ? "junction" : "dir"),
        )
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: secretA }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: path.join(link, "sensitive.txt") }))
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: path.dirname(secretA) }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([])))
        const result = yield* ReviewService.execute(
          {
            version: 1,
            mode: "review",
            directory,
            target: { kind: "branch", base, head },
            settingsRef: base,
            model: "lmstudio/test-model",
            readDenies: [path.join(link, "sensitive.txt")],
          },
          {
            resolveModel: (request) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => fs.unlink(link))
                yield* Effect.promise(() =>
                  fs.symlink(path.dirname(secretB), link, process.platform === "win32" ? "junction" : "dir"),
                )
                return yield* resolveReviewModel(request)
              }),
            runReview: Review.run,
            confirm: async () => false,
            stdout: async () => {},
            stderr: () => {},
            posting: async () => {
              throw new Error("The stateless review cannot post")
            },
          },
        )
        expect(result.exitCode).toBe(0)
        expect(result.verdict.verdict).toBe("incomplete")
        expect(result.outcome?.unreviewed).toContain("secret-a/sensitive.txt")
        expect(result.outcome?.sessions).toHaveLength(1)
        const sessions = yield* Session.Service
        const tools = (yield* sessions.messages({ sessionID: SessionID.make(result.outcome!.sessions[0]!) }))
          .flatMap((message) => message.parts)
          .flatMap((part) => (part.type === "tool" && part.tool === "read" ? [part] : []))
        expect(tools.map((part) => part.state.status)).toEqual(["error", "error", "completed"])
        expect(JSON.stringify(tools)).not.toContain("WITHHELD_ADMITTED_CANONICAL_A")
        expect(JSON.stringify(yield* modelRequests(llm))).not.toContain("WITHHELD_ADMITTED_CANONICAL_A")
        expect(JSON.stringify(yield* modelRequests(llm))).not.toContain("WITHHELD_RETARGET_B")
        const directoryRead = tools[2]
        if (directoryRead?.state.status === "completed")
          expect(directoryRead.state.output).not.toContain("sensitive.txt")
      }),
    { git: true },
    TIMEOUT,
  )

  it.instance(
    "an absolute requester denial survives actual helper Read, Grep and Glob resource names",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const fs = yield* FSUtil.Service
        const protectedFile = path.join(directory, "private.txt")
        yield* fs.writeWithDirs(protectedFile, "VECTOR_AUTHORITY_MARKER WITHHELD_REVIEW_CONTENT\n")
        yield* fs.writeWithDirs(path.join(directory, "visible.txt"), "VECTOR_AUTHORITY_MARKER VISIBLE_REVIEW_CONTENT\n")
        yield* llm.pushMatch(REVIEW, reply().tool("read", { filePath: "private.txt" }))
        yield* llm.pushMatch(REVIEW, reply().tool("grep", { pattern: "VECTOR_AUTHORITY_MARKER", path: directory }))
        yield* llm.pushMatch(REVIEW, reply().tool("glob", { pattern: "*.txt", path: directory }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([])))
        const outcome = yield* Review.run(input(directory, { readDenies: [protectedFile] }))
        const sessions = yield* Session.Service
        const tools = (yield* sessions.messages({ sessionID: SessionID.make(outcome.sessions[0]!) }))
          .flatMap((message) => message.parts)
          .flatMap((part) => (part.type === "tool" ? [part] : []))
        expect(tools.find((part) => part.tool === "read")?.state.status).toBe("error")
        const grep = tools.find((part) => part.tool === "grep")
        expect(grep?.state.status).toBe("completed")
        if (grep?.state.status === "completed") expect(grep.state.output).toContain("VISIBLE_REVIEW_CONTENT")
        const glob = tools.find((part) => part.tool === "glob")
        expect(glob?.state.status).toBe("completed")
        if (glob?.state.status === "completed") {
          expect(glob.state.output).toContain("visible.txt")
          expect(glob.state.output).not.toContain("private.txt")
        }
        expect(JSON.stringify(yield* modelRequests(llm))).not.toContain("WITHHELD_REVIEW_CONTENT")
        const permission = yield* Permission.Service
        expect(yield* permission.list()).toEqual([])
      }),
    TIMEOUT,
  )

  it.instance(
    "runs the first pass on the triage model and double-checks every concern on the review model",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const provider = testProviderConfig(llm.url)
        Object.assign(provider.provider.lmstudio.models, {
          "cheap-model": { ...provider.provider.lmstudio.models["test-model"], id: "cheap-model", name: "Cheap" },
        })
        yield* fs.writeWithDirs(
          path.join(test.directory, "vector.json"),
          JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...provider }),
        )
        yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
        yield* Effect.promise(() => trustWorkspace(test.directory))
        const cheap = { ...ref, modelID: ModelV2.ID.make("cheap-model"), context: 100_000, costKind: "free" as const }

        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding({ severity: "concern" })]))
            .usage({ input: 2_000, output: 100 }),
        )
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", { results: [] }).usage({ input: 1_000, output: 50 }),
        )
        const outcome = yield* Review.run(
          input(test.directory, { triage: cheap, config: config({ verify: "blocking" }) }),
        )
        const hits = yield* llm.hits
        expect(hits.filter(REVIEW).map((hit) => hit.body.model)).toEqual(["cheap-model"])
        expect(hits.filter(VERIFY).map((hit) => hit.body.model)).toEqual(["test-model"])
        expect(outcome.specialists.map((item) => [item.name, item.status])).toEqual([
          ["review", "ok"],
          ["verify", "ok"],
        ])
        expect(outcome.passes?.map((pass) => [pass.name, pass.model, pass.input, pass.output])).toEqual([
          ["review", "lmstudio/cheap-model", 2_000, 100],
          ["verify", "lmstudio/test-model", 1_000, 50],
        ])
        expect(outcome.cost?.model).toBe("lmstudio/cheap-model + lmstudio/test-model")
        // The review model gave no verdict, so the cheap model's concern is not reported.
        expect(outcome.selection.inline).toEqual([])
        expect(outcome.selection.dropped).toEqual([{ reason: "unconfirmed", count: 1 }])

        // Without a triage model the same concern is not double-checked under verify "blocking".
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding({ severity: "concern" })])))
        const plain = yield* Review.run(input(test.directory, { config: config({ verify: "blocking" }) }))
        expect(plain.specialists.map((item) => item.name)).toEqual(["review"])
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(1)
      }),
    TIMEOUT,
  )

  it.instance(
    "after a triage pass reports only what the review model confirmed, even with verify off or the check skipped",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const provider = testProviderConfig(llm.url)
        Object.assign(provider.provider.lmstudio.models, {
          "cheap-model": { ...provider.provider.lmstudio.models["test-model"], id: "cheap-model", name: "Cheap" },
        })
        yield* fs.writeWithDirs(
          path.join(test.directory, "vector.json"),
          JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...provider }),
        )
        yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
        yield* Effect.promise(() => trustWorkspace(test.directory))
        const cheap = { ...ref, modelID: ModelV2.ID.make("cheap-model"), context: 100_000, costKind: "free" as const }
        const blocking = finding()
        const concern = finding({ line: 2, severity: "concern", title: "index is computed but never checked" })
        const [blockingID] = Review.normalizeFindings([blocking], "review", LIST).map((item) => item.id)

        // verify "off" does not turn the double-check off under a triage model; only the confirmed finding stays.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([blocking, concern])))
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", {
            results: [{ id: blockingID, verdict: "confirmed", reason: "Reproduced." }],
          }),
        )
        const off = yield* Review.run(input(test.directory, { triage: cheap, config: config({ verify: "off" }) }))
        expect(off.specialists.map((item) => [item.name, item.status])).toEqual([
          ["review", "ok"],
          ["verify", "ok"],
        ])
        expect(off.selection.inline.map((item) => [item.id, item.verified])).toEqual([[blockingID, true]])
        expect(off.selection.dropped).toEqual([{ reason: "unconfirmed", count: 1 }])

        // With too little budget left for the double-check, nothing from the cheap pass is reported, and the note
        // says why.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([blocking, concern])))
        const skipped = yield* Review.run(
          input(test.directory, {
            triage: cheap,
            model: priced,
            config: config({ verify: "blocking", maxCostUsd: 0.000_001 }),
          }),
        )
        expect(skipped.specialists.at(-1)).toEqual({ name: "verify", status: "skipped", steps: 0, detail: "budget" })
        expect(skipped.selection.inline).toEqual([])
        expect(skipped.selection.dropped).toEqual([{ reason: "unconfirmed", count: 2 }])
        expect(skipped.notes).toContain(noteTriageUnchecked(2, "lmstudio/cheap-model", "lmstudio/test-model"))
        expect(skipped.notes).not.toContain(noteVerifySkipped())
      }),
    TIMEOUT,
  )

  it.instance(
    "after a triage pass an earlier finding counts as fixed only once the review model confirmed it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const provider = testProviderConfig(llm.url)
        Object.assign(provider.provider.lmstudio.models, {
          "cheap-model": { ...provider.provider.lmstudio.models["test-model"], id: "cheap-model", name: "Cheap" },
        })
        yield* fs.writeWithDirs(
          path.join(test.directory, "vector.json"),
          JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...provider }),
        )
        yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
        yield* Effect.promise(() => trustWorkspace(test.directory))
        const cheap = { ...ref, modelID: ModelV2.ID.make("cheap-model"), context: 100_000, costKind: "free" as const }
        const open = {
          id: "abcdef012345",
          where: "inline" as const,
          path: "src/list.ts",
          line: 3,
          side: "RIGHT" as const,
          severity: "blocking" as const,
          category: "security" as const,
          title: "Token is never verified",
          sha: "1111111",
          status: "open" as const,
          commentId: 9,
        }
        const claimed = { ...report([]), priorStatus: [{ id: open.id, status: "fixed", reason: "looks fine" }] }
        const triaged = input(test.directory, { triage: cheap, prior: [open], config: config({ verify: "all" }) })

        // The review model gives no verdict on the claim: the finding stays open.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", claimed))
        yield* llm.pushMatch(VERIFY, reply().tool("StructuredOutput", { results: [] }))
        const unconfirmed = yield* Review.run(triaged)
        const checks = (yield* llm.hits).filter(VERIFY)
        expect(checks.map((hit) => hit.body.model)).toEqual(["test-model"])
        expect(lastUserText(checks[0]!.body)).toContain(`<untrusted_fixed_claim id="${open.id}"`)
        expect(unconfirmed.report.priorStatus ?? []).toEqual([])

        // It rejects the claim: still open.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", claimed))
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", {
            results: [{ id: open.id, verdict: "rejected", reason: "verify() is still skipped." }],
          }),
        )
        expect((yield* Review.run(triaged)).report.priorStatus ?? []).toEqual([])

        // It confirms the fix: now it counts.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", claimed))
        yield* llm.pushMatch(
          VERIFY,
          reply().tool("StructuredOutput", {
            results: [{ id: open.id, verdict: "confirmed", reason: "verify() runs first now." }],
          }),
        )
        expect((yield* Review.run(triaged)).report.priorStatus).toEqual([
          { id: open.id, status: "fixed", reason: "looks fine" },
        ])

        // With too little budget left for the check, the claim is not taken, and the summary says so.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", claimed))
        const skipped = yield* Review.run({
          ...triaged,
          model: priced,
          config: config({ verify: "all", maxCostUsd: 0.000_001 }),
        })
        expect(skipped.specialists.at(-1)).toMatchObject({ name: "verify", status: "skipped" })
        expect(skipped.report.priorStatus ?? []).toEqual([])
        expect(skipped.notes).toEqual([noteTriageFixedUnchecked(1, "lmstudio/cheap-model", "lmstudio/test-model")])

        // Without a triage model the review model's own word stands, as before.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", claimed))
        const plain = yield* Review.run(input(test.directory, { prior: [open] }))
        expect(plain.report.priorStatus).toEqual([{ id: open.id, status: "fixed", reason: "looks fine" }])
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(3)
      }),
    TIMEOUT,
  )

  it.instance(
    "sends an untrusted change once, annotated, and only the changed lines of a file with nothing new",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const other = parseUnifiedDiff(
          [
            "diff --git a/src/other.ts b/src/other.ts",
            "--- a/src/other.ts",
            "+++ b/src/other.ts",
            "@@ -1,3 +1,3 @@",
            " export function other() {",
            "-  return 1",
            "+  return 2",
            " }",
          ].join("\n"),
        )
        const files = [...LIST, ...other]
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        yield* Review.run(
          input(directory, {
            trust: "untrusted",
            mode: "incremental",
            since: "3".repeat(40),
            files,
            anchors: files,
            focus: [{ path: "src/list.ts", start: 1, end: 4 }],
            headFiles: [
              { path: "src/list.ts", text: LIST_SOURCE, exact: true },
              { path: "src/other.ts", text: "export function other() {\n  return 2\n}\n", exact: true },
            ],
          }),
        )
        const text = lastUserText((yield* llm.hits).find(REVIEW)!.body)
        expect(text).toContain('<untrusted_pr_file path="src/list.ts" exact="true" annotated="true">')
        expect(text).toContain("2 +   const index = items.length")
        expect(text).not.toContain('<untrusted_pr_file path="src/other.ts"')
        expect(text).toContain("@@ -2,1 +2,1 @@\n-  return 1\n+  return 2")
        expect(text).not.toContain(" export function other() {")
        expect(text).toContain("their diff is shown without context lines")
      }),
    TIMEOUT,
  )

  it.instance(
    "a failed reviewer reports its first turn's error, not the finalizer's that followed from it",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, httpError(400, { error: { message: "This model does not support tools" } }))
        yield* llm.pushMatch(FINALIZE, reply().text("Nothing to add.").stop())

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "failed" })
        expect(outcome.specialists[0]?.detail).toContain("This model does not support tools")
        expect(outcome.specialists[0]?.detail).not.toContain("structured output")
      }),
    TIMEOUT,
  )

  it.instance(
    "a failed reviewer whose first turn only missed the report names the finalizer's provider error",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, reply().text("Looks fine to me.").stop())
        yield* llm.pushMatch(FINALIZE, httpError(400, { error: { message: "Your credit balance is too low" } }))

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "failed" })
        expect(outcome.specialists[0]?.detail).toContain("Your credit balance is too low")
        expect(outcome.specialists[0]?.detail).not.toContain("structured output")
      }),
    TIMEOUT,
  )

  it.instance(
    "marks a run whose model fails as a model error and leaves every file unreviewed",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        yield* llm.pushMatch(REVIEW, httpError(400, { error: { message: "bad request" } }))
        yield* llm.pushMatch(FINALIZE, httpError(400, { error: { message: "bad request" } }))

        const outcome = yield* Review.run(input(directory))

        expect(outcome.specialists[0]).toMatchObject({ name: "review", status: "failed" })
        expect(outcome.partial).toBe("model-error")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
        expect(outcome.selection.inline).toEqual([])
      }),
    TIMEOUT,
  )
})

// VS-06: one verify policy for every surface, behind the off-by-default "verifyPolicy": "shared" (D3). With it off
// the engine keeps its own rule, which the tests above pin and these compare against.
describe("the verify policy", () => {
  const blocking = finding()
  const concern = finding({ line: 2, severity: "concern", title: "index is computed but never checked" })
  const nit = finding({
    line: 2,
    severity: "nit",
    category: "maintainability",
    title: "Name the index for what it is",
    suggestion: "  const end = items.length",
  })
  const [blockingID, concernID, nitID] = Review.normalizeFindings([blocking, concern, nit], "review", LIST).map(
    (item) => item.id,
  )
  const candidateIDs = (body: Record<string, unknown>) =>
    [...lastUserText(body).matchAll(/<untrusted_candidate id="([^"]+)"/g)].map((match) => match[1])

  it.instance(
    "legacy keeps the engine's rule; shared adds every untrusted suggestion, honours an explicit setting and defaults to all",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        // Each review reports the same three findings; returns the ids the verify pass was asked about, if it ran.
        const checked = (overrides: Partial<Review.RunInput>, verified = true) =>
          Effect.gen(function* () {
            const before = (yield* llm.hits).filter(VERIFY).length
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([blocking, concern, nit])))
            if (verified) yield* llm.pushMatch(VERIFY, reply().tool("StructuredOutput", { results: [] }))
            const outcome = yield* Review.run(input(directory, overrides))
            const asked = (yield* llm.hits).filter(VERIFY).slice(before)
            expect(asked).toHaveLength(verified ? 1 : 0)
            return { outcome, ids: asked[0] ? candidateIDs(asked[0].body) : [] }
          })

        // Legacy, untrusted, "all": the engine has never sent the nit's suggestion to the verify pass.
        const legacy = yield* checked({ trust: "untrusted", config: config({ verify: "all" }) })
        expect(legacy.ids).toEqual([blockingID, concernID])
        expect(legacy.outcome.notes).toEqual([])
        const legacyBlocking = yield* checked({ trust: "untrusted", config: config({ verify: "blocking" }) })
        expect(legacyBlocking.ids).toEqual([blockingID, nitID])

        // Shared, untrusted: every suggestion is a candidate, under "all" and under an explicit "blocking".
        const all = yield* checked({ trust: "untrusted", config: config({ verify: "all", verifyPolicy: "shared" }) })
        expect(all.ids).toEqual([blockingID, concernID, nitID])
        const explicit = yield* checked({
          trust: "untrusted",
          config: config({ verify: "blocking", verifyPolicy: "shared" }),
        })
        expect(explicit.ids).toEqual([blockingID, nitID])
        // An explicit "off" still turns it off, and the findings stand unverified.
        const off = yield* checked({ config: config({ verify: "off", verifyPolicy: "shared" }) }, false)
        expect(off.outcome.specialists.map((item) => item.name)).toEqual(["review"])
        expect(off.outcome.notes).toEqual([])

        // From review.json: the policy alone makes "all" the default; without it the default stays "blocking".
        const parsed = (json: object) => parseReviewConfig({ json: JSON.stringify(json), trigger: "local" }).config
        const opted = yield* checked({ config: parsed({ verifyPolicy: "shared" }) })
        expect(opted.ids).toEqual([blockingID, concernID])
        const today = yield* checked({ config: parsed({}) })
        expect(today.ids).toEqual([blockingID])
      }),
    TIMEOUT,
  )

  it.instance(
    "shared: a verify pass that was skipped, denied by the budget or failed says how many findings it left unchecked",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const policies = ["legacy", "shared"] as const

        // Skipped before it started: too little budget was left after the review.
        const skipped = yield* Effect.forEach(policies, (verifyPolicy) =>
          Effect.gen(function* () {
            yield* llm.pushMatch(
              REVIEW,
              reply()
                .tool("StructuredOutput", report([blocking]))
                .usage({ input: 50_000, output: 100 }),
            )
            return yield* Review.run(
              input(directory, {
                model: priced,
                config: config({ verify: "blocking", verifyPolicy, maxCostUsd: 0.6 }),
              }),
            )
          }),
        )
        for (const outcome of skipped)
          expect(outcome.specialists.at(-1)).toEqual({ name: "verify", status: "skipped", steps: 0, detail: "budget" })
        expect(skipped.map((outcome) => outcome.notes)).toEqual([
          [noteVerifySkipped()],
          [noteVerifyUnfinished(1, "budget")],
        ])

        // Admitted, then denied: its first step used most of the budget, so its next step and its finalizer are
        // refused. Legacy said nothing about it.
        const denied = yield* Effect.forEach(policies, (verifyPolicy) =>
          Effect.gen(function* () {
            yield* llm.pushMatch(
              REVIEW,
              reply()
                .tool("StructuredOutput", report([blocking]))
                .usage({ input: 1_000, output: 10 }),
            )
            yield* llm.pushMatch(
              VERIFY,
              reply()
                .tool("read", { filePath: path.join(directory, "src/list.ts") })
                .usage({ input: 50_000, output: 10 }),
            )
            return yield* Review.run(
              input(directory, {
                model: priced,
                config: config({ verify: "blocking", verifyPolicy, maxCostUsd: 0.6 }),
              }),
            )
          }),
        )
        for (const outcome of denied) {
          expect(outcome.specialists.at(-1)).toMatchObject({ name: "verify", status: "stopped", detail: "budget" })
          expect(outcome.selection.inline.map((item) => [item.id, item.verified])).toEqual([[blockingID, undefined]])
          expect(outcome.partial).toBeUndefined()
        }
        expect(denied.map((outcome) => outcome.notes)).toEqual([[], [noteVerifyUnfinished(1, "budget")]])

        // Failed: it answered in prose, and so did its finalizer. Legacy said nothing about this either.
        const failed = yield* Effect.forEach(policies, (verifyPolicy) =>
          Effect.gen(function* () {
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([blocking, concern])))
            yield* llm.pushMatch(VERIFY, reply().text("They all look real to me.").stop())
            yield* llm.pushMatch(FINALIZE, reply().text("Nothing to add.").stop())
            return yield* Review.run(input(directory, { config: config({ verify: "all", verifyPolicy }) }))
          }),
        )
        for (const outcome of failed) {
          expect(outcome.specialists.at(-1)).toMatchObject({ name: "verify", status: "failed" })
          expect(outcome.selection.inline.map((item) => item.verified)).toEqual([undefined, undefined])
        }
        expect(failed.map((outcome) => outcome.notes)).toEqual([[], [noteVerifyUnfinished(2, "unfinished")]])

        // Skipped for time: less than the verify pass's two minutes was left of the review's one.
        const late = yield* Effect.forEach(policies, (verifyPolicy) =>
          Effect.gen(function* () {
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([blocking])))
            return yield* Review.run(
              input(directory, { config: config({ verify: "blocking", verifyPolicy, timeoutMinutes: 1 }) }),
            )
          }),
        )
        for (const outcome of late)
          expect(outcome.specialists.at(-1)).toEqual({ name: "verify", status: "skipped", steps: 0, detail: "time" })
        expect(late.map((outcome) => outcome.notes)).toEqual([[noteVerifySkipped()], [noteVerifyUnfinished(1, "time")]])
      }),
    TIMEOUT,
  )

  it.instance(
    "shared: a verify pass that finished without a verdict for some findings says so, after a triage pass too",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const llm = yield* TestLLMServer
        const fs = yield* FSUtil.Service
        const provider = testProviderConfig(llm.url)
        Object.assign(provider.provider.lmstudio.models, {
          "cheap-model": { ...provider.provider.lmstudio.models["test-model"], id: "cheap-model", name: "Cheap" },
        })
        yield* fs.writeWithDirs(
          path.join(test.directory, "vector.json"),
          JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...provider }),
        )
        yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
        yield* Effect.promise(() => trustWorkspace(test.directory))
        const cheap = { ...ref, modelID: ModelV2.ID.make("cheap-model"), context: 100_000, costKind: "free" as const }
        const policies = ["legacy", "shared"] as const
        // The verify pass finishes, but answers for the blocking finding alone.
        const onlyBlocking = () =>
          llm.pushMatch(
            VERIFY,
            reply().tool("StructuredOutput", {
              results: [{ id: blockingID, verdict: "confirmed", reason: "Reproduced." }],
            }),
          )

        // Without a triage pass the concern is posted unverified, as before; the shared policy says so.
        const plain = yield* Effect.forEach(policies, (verifyPolicy) =>
          Effect.gen(function* () {
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([blocking, concern])))
            yield* onlyBlocking()
            return yield* Review.run(input(test.directory, { config: config({ verify: "all", verifyPolicy }) }))
          }),
        )
        for (const outcome of plain) {
          expect(outcome.specialists.at(-1)).toMatchObject({ name: "verify", status: "ok" })
          expect(outcome.selection.inline.map((item) => [item.id, item.verified])).toEqual([
            [blockingID, true],
            [concernID, undefined],
          ])
        }
        expect(plain.map((outcome) => outcome.notes)).toEqual([[], [noteVerifyUnfinished(1, "unanswered")]])

        // After a triage pass the concern is left out, as before; the shared policy says so. Untrusted, it also checks
        // the nit's suggestion, which is posted without a verdict and counted too.
        const triaged = yield* Effect.forEach(policies, (verifyPolicy) =>
          Effect.gen(function* () {
            const before = (yield* llm.hits).filter(VERIFY).length
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([blocking, concern, nit])))
            yield* onlyBlocking()
            const outcome = yield* Review.run(
              input(test.directory, {
                triage: cheap,
                trust: "untrusted",
                config: config({ verify: "all", verifyPolicy, nits: true }),
              }),
            )
            const asked = (yield* llm.hits).filter(VERIFY).slice(before)
            return { outcome, ids: asked[0] ? candidateIDs(asked[0].body) : [] }
          }),
        )
        expect(triaged.map((entry) => entry.ids)).toEqual([
          [blockingID, concernID],
          [blockingID, concernID, nitID],
        ])
        for (const { outcome } of triaged) {
          expect(outcome.specialists.at(-1)).toMatchObject({ name: "verify", status: "ok" })
          expect(outcome.selection.inline.map((item) => [item.id, item.verified])).toEqual([[blockingID, true]])
          expect(outcome.selection.dropped).toContainEqual({ reason: "unconfirmed", count: 1 })
        }
        expect(triaged.map((entry) => entry.outcome.notes)).toEqual([
          [],
          [
            noteTriageUnchecked(1, "lmstudio/cheap-model", "lmstudio/test-model", "unanswered"),
            noteVerifyUnfinished(1, "unanswered"),
          ],
        ])
      }),
    TIMEOUT,
  )
})

describe("model evidence (VS-07)", () => {
  // The certificate a held-out run would have given the test model, in the scope these reviews run in. Review.run reads
  // the clock, so the dates are around today: collected two days ago, approved yesterday, expiring in thirty days.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const certificate = (scope: ReturnType<typeof evidenceScope>): ModelCertificate => ({
    version: 1,
    id: "vs-test",
    model: "lmstudio/test-model",
    adapters: ["engine"],
    pipeline: scope.pipeline,
    prompts: scope.prompts,
    policy: scope.policy,
    evaluation: {
      report: `sha256:${"a".repeat(64)}`,
      manifest: `sha256:${"b".repeat(64)}`,
      split: "held-out",
      decision: "D2",
      gate: "c".repeat(16),
      collected: day(-2),
    },
    approved: { by: "owner", date: day(-1) },
    expires: day(30),
  })
  const stable = (outcome: ReviewOutcome) => {
    const { durationMs: _duration, sessions: _sessions, notes: _notes, ...rest } = outcome
    return rest
  }

  it.instance(
    "off by default: the same review sends the same requests and gives the same outcome, with no note; warn only adds notes",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const reviewed = (overrides: Partial<Review.RunInput>) =>
          Effect.gen(function* () {
            const before = (yield* modelRequests(llm)).length
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
            const outcome = yield* Review.run(input(directory, overrides))
            const sent = (yield* modelRequests(llm)).slice(before).map((body) => body.model)
            return { outcome, sent }
          })

        const today = yield* reviewed({ config: config() })
        const warn = yield* reviewed({ config: config({ modelEvidence: "warn" }) })
        expect(today.outcome.notes).toEqual([])
        expect(warn.sent).toEqual(today.sent)
        expect(warn.sent).toEqual(["test-model"])
        expect(stable(warn.outcome)).toEqual(stable(today.outcome))
        // A model built without the resolver says only what it is; it never names another model to use.
        expect(warn.outcome.notes).toEqual([
          "`lmstudio/test-model` has no VectorScope evaluation on record, so how well it reviews is unmeasured.",
        ])
      }),
    TIMEOUT,
  )

  it.instance(
    "warn: a certified model says nothing about quality, but a provider that may train on the code is still named",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const before = (yield* modelRequests(llm)).length
        const warn = config({ modelEvidence: "warn" })
        const certificates = [certificate(evidenceScope({ adapter: "engine", config: warn }))]
        expect(certificateProblems(certificates[0])).toEqual([])
        const model = {
          ...ref,
          context: 100_000,
          costKind: "priced" as const,
          subject: { model: "lmstudio/test-model", free: false, choice: { explicit: true, setting: "--model" } },
        }

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        const certified = yield* Review.run(input(directory, { model, config: warn, certificates }))
        expect(certified.notes).toEqual([])

        // Another review setting is another scope: the certificate no longer applies, and the note says why.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        const stale = yield* Review.run(
          input(directory, { model, config: { ...warn, minConfidence: 0.2 }, certificates }),
        )
        expect(stale.notes).toEqual([
          "The VectorScope evaluation of `lmstudio/test-model` on record (`vs-test`) was made with other review settings, so it does not apply here. Vector used it because --model names it, and does not switch a chosen model.",
        ])

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        const trainer = yield* Review.run(
          input(directory, {
            model: {
              ...model,
              costKind: "free",
              subject: { ...model.subject, free: true, freeModel: { source: "openrouter", dataPolicy: "may-train" } },
            },
            config: warn,
            certificates,
          }),
        )
        expect(trainer.notes).toEqual([
          '`lmstudio/test-model` is labelled "May train on your prompts": its provider may log the code it is sent and use it to train models. Don\'t use it for private code. Vector used it because --model names it, and does not switch a chosen model.',
        ])
        // Every review ran on the model it was given.
        expect((yield* modelRequests(llm)).slice(before).map((body) => body.model)).toEqual([
          "test-model",
          "test-model",
          "test-model",
        ])
      }),
    TIMEOUT,
  )
})

// VS-21b: the projection hook, which only ReviewEval.project sets. It is asked about each decision the dollar cap
// would refuse, and nothing else.
describe("the projection hook (VS-21b)", () => {
  // Three reviews whose dollar cap refuses something, and where: review refused before its session; review's second
  // attempt and then its finalizer's reservation; and verify's pre-check after review's report.
  const scenarios = (
    directory: string,
  ): {
    name: string
    config: ReviewConfig
    replies: () => ReturnType<typeof reply>[]
    sites: Review.OverCap["site"][]
  }[] => [
    { name: "pass", config: config({ maxCostUsd: 0.00001 }), replies: () => [], sites: ["pass"] },
    {
      name: "attempt",
      config: config({ maxCostUsd: 0.8 }),
      replies: () => [
        reply()
          .tool("read", { filePath: path.join(directory, "src/list.ts") })
          .usage({ input: 40_000, output: 100 }),
      ],
      sites: ["attempt", "finalizer"],
    },
    {
      name: "verify",
      config: config({ verify: "blocking", maxCostUsd: 0.6 }),
      replies: () => [
        reply()
          .tool("StructuredOutput", report([finding()]))
          .usage({ input: 50_000, output: 100 }),
      ],
      sites: ["verify"],
    },
  ]

  // What one review sends and returns, without its duration and session IDs, which differ between runs.
  const observeRun = (llm: TestLLMServer["Service"], run: Review.RunInput, replies: ReturnType<typeof reply>[]) =>
    Effect.gen(function* () {
      yield* llm.reset
      for (const item of replies) yield* llm.pushMatch(REVIEW, item)
      const outcome = yield* Review.run(run)
      const { durationMs: _duration, sessions: _sessions, ...rest } = outcome
      return {
        bodies: (yield* modelRequests(llm)).map((body) => JSON.stringify(body)),
        outcome: rest,
        sessions: outcome.sessions,
      }
    })

  it.instance(
    "D3: unset, declining or throwing, the review sends the same requests and returns the same outcome",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        for (const scenario of scenarios(directory)) {
          const asked: Review.OverCap[] = []
          const refused: Extract<Review.Observation, { type: "attempt" }>[] = []
          const run = input(directory, { model: priced, config: scenario.config })
          const unset = yield* observeRun(llm, run, scenario.replies())
          const declining = yield* observeRun(
            llm,
            {
              ...run,
              projection: { overCap: (decision) => (asked.push(decision), false) },
              observe: (event) => {
                if (event.type === "attempt" && !event.admitted && event.stop === "budget") refused.push(event)
              },
            },
            scenario.replies(),
          )
          const throwing = yield* observeRun(
            llm,
            {
              ...run,
              projection: {
                overCap: () => {
                  throw new Error("a projection that throws refuses")
                },
              },
            },
            scenario.replies(),
          )
          expect(declining.bodies).toEqual(unset.bodies)
          expect(throwing.bodies).toEqual(unset.bodies)
          expect(declining.outcome).toEqual(unset.outcome)
          expect(throwing.outcome).toEqual(unset.outcome)
          // The declining hook was asked about exactly the decisions the cap refused, where it refused them.
          expect(asked.map((decision) => decision.site)).toEqual(scenario.sites)
          for (const decision of asked) {
            expect(decision.estimateUsd).toBeGreaterThan(0)
            expect(decision.sessionID !== undefined).toBe(decision.site === "attempt" || decision.site === "finalizer")
            expect(decision.phase).toBe(decision.site === "finalizer" ? "finalize" : "turn")
          }
          // Each decision carries the whole reservation that went over the cap. The refusal it caused records the
          // turn's estimate alone; before a session and at a turn's attempt the turn reserves the same amount again
          // for its finalizer, and the finalizer, a finalizing attempt and verify reserve no such share.
          expect(refused.map((event) => event.phase)).toEqual(asked.map((decision) => decision.phase))
          asked.forEach((decision, index) =>
            expect(decision.estimateUsd).toBe(
              (refused[index]?.estimateUsd ?? Number.NaN) *
                (decision.site === "pass" || (decision.site === "attempt" && decision.phase === "turn") ? 2 : 1),
            ),
          )
          const session = asked.find((decision) => decision.sessionID)?.sessionID
          if (session) expect(declining.sessions).toContain(session)
        }
        expect(scenarios(directory).map((scenario) => scenario.name)).toEqual(["pass", "attempt", "verify"])
      }),
    TIMEOUT,
  )

  it.instance(
    "runs what the cap refuses when the hook says so, and is never asked about what the cap admits",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const asked: Review.OverCap[] = []
        const lifting: Review.Projection = { overCap: (decision) => (asked.push(decision), true) }

        // The cap refuses review before its session and at its attempt; lifted, review runs and reports.
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }))
        const lifted = yield* Review.run(
          input(directory, { model: priced, config: config({ maxCostUsd: 0.00001 }), projection: lifting }),
        )
        expect(lifted.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
        expect(yield* modelRequests(llm)).toHaveLength(1)
        expect(asked.map((decision) => [decision.pass, decision.site])).toEqual([
          ["review", "pass"],
          ["review", "attempt"],
        ])
        expect(asked[1]?.sessionID).toBe(SessionID.make(lifted.sessions[0]!))

        // The "attempt" scenario: after a read, the cap refuses review's second attempt. Lifted, that turn answers in
        // prose, so review is finalized; the cap refuses the finalizer's reservation and its admission, and lifted,
        // the finalizer reaches the server and review reports.
        asked.length = 0
        yield* llm.reset
        const attempt = scenarios(directory).find((scenario) => scenario.name === "attempt")!
        for (const item of attempt.replies()) yield* llm.pushMatch(REVIEW, item)
        yield* llm.pushMatch(REVIEW, reply().text("I looked around.").usage({ input: 40_000, output: 100 }).stop())
        yield* llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }))
        const finalized = yield* Review.run(
          input(directory, { model: priced, config: attempt.config, projection: lifting }),
        )
        expect(finalized.specialists[0]).toMatchObject({ name: "review", status: "ok" })
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(1)
        expect(asked.map((decision) => [decision.site, decision.phase])).toEqual([
          ["attempt", "turn"],
          ["finalizer", "finalize"],
          ["attempt", "finalize"],
        ])
        expect(asked.every((decision) => decision.sessionID === SessionID.make(finalized.sessions[0]!))).toBe(true)

        // A cap that admits everything, and an uncapped review, never ask.
        asked.length = 0
        yield* llm.reset
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }))
        const admitted = yield* Review.run(
          input(directory, { model: priced, config: config({ maxCostUsd: 100 }), projection: lifting }),
        )
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()).usage({ input: 1_000, output: 100 }))
        const uncapped = yield* Review.run(
          input(directory, {
            model: { ...priced, costKind: "plan" },
            config: config({ maxCostUsd: 0.00001 }),
            projection: lifting,
          }),
        )
        expect([admitted.specialists, uncapped.specialists]).toEqual([
          [{ name: "review", status: "ok", steps: 1 }],
          [{ name: "review", status: "ok", steps: 1 }],
        ])
        expect(asked).toEqual([])
      }),
    TIMEOUT,
  )

  it.instance(
    "is not asked about a verify pass that is skipped for time",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const asked: Review.OverCap[] = []
        yield* llm.pushMatch(
          REVIEW,
          reply()
            .tool("StructuredOutput", report([finding()]))
            .usage({ input: 50_000, output: 100 }),
        )
        // A one-minute review leaves verify less than its two minutes, and the cap refuses it too.
        const outcome = yield* Review.run(
          input(directory, {
            model: priced,
            config: config({ verify: "blocking", maxCostUsd: 0.6, timeoutMinutes: 1 }),
            projection: { overCap: (decision) => (asked.push(decision), true) },
          }),
        )
        expect(outcome.specialists).toEqual([
          { name: "review", status: "ok", steps: 1 },
          { name: "verify", status: "skipped", steps: 0, detail: "budget" },
        ])
        expect(asked).toEqual([])
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(0)
      }),
    TIMEOUT,
  )
})
