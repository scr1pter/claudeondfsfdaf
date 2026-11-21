import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Schema, Stream } from "effect"
import { LLMEvent, Usage } from "@vectordevai/llm"
import { BrainLearn } from "@vectordevai/core/brain/learn"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { buildPrompt } from "@vectordevai/core/session/compaction"
import { Database } from "@vectordevai/core/database/database"
import { BrainDatabase } from "@vectordevai/core/brain/database"
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
import { CREDENTIAL_FILES, holdsBack, reviewPermissionRules } from "@vectordevai/core/review/permission"
import { INPUT_REDACTION, PINNED_SESSION_PREFIX, VECTORSCOPE_AGENT } from "@vectordevai/core/review/prompt"
import { certificateProblems, evidenceScope, type ModelCertificate } from "@vectordevai/core/review/model-evidence"
import {
  noteHeldBack,
  noteIgnoreUnchecked,
  noteIgnoredCommitted,
  notePrivacyRefused,
  noteRedacted,
  noteTriageFixedUnchecked,
  noteTriageUnchecked,
  noteVerifySkipped,
  noteVerifyUnfinished,
} from "@vectordevai/core/review/format"
import { reviewVerdict } from "@vectordevai/core/review/verdict"
import { decideSkip } from "@vectordevai/core/review/skip"
import { nextState } from "@vectordevai/core/review/state"
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
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, trustWorkspace, reloadInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { httpError, reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { resolveReviewModel, type ResolveInput } from "../../src/review/model"
import { ReviewRoutes } from "../../src/review/route"
import { TestConfig } from "../fixture/config"

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
  BrainDatabase.node,
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
// Only genuine private Git snapshot integrations require this supported host.
const linuxInstance = process.platform === "linux" ? it.instance : it.instance.skip
const windowsInstance = process.platform === "win32" ? it.instance : it.instance.skip

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
// A compaction summary's request (compaction.ts), which ends with core's summary prompt.
const SUMMARY = answering(buildPrompt({ context: [] }))

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
  windowsInstance(
    "Windows private review admission refuses before model resolution or the actual review runner",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const git = yield* Git.Service
        const actual = yield* git.run(["rev-parse", "HEAD"], { cwd: directory })
        expect(actual.exitCode).toBe(0)
        const head = actual.text().trim()
        let resolved = 0
        let reviewed = 0
        const result = yield* ReviewService.execute(
          {
            version: 1,
            mode: "review",
            directory,
            target: { kind: "working-tree", head },
            settingsRef: head,
            model: "lmstudio/test-model",
          },
          {
            resolveModel: (request) => Effect.sync(() => resolved++).pipe(Effect.andThen(resolveReviewModel(request))),
            runReview: (request) => Effect.sync(() => reviewed++).pipe(Effect.andThen(Review.run(request))),
            confirm: async () => false,
            stdout: async () => {},
            stderr: () => {},
            posting: async () => {
              throw new Error("An unsupported private review cannot post")
            },
          },
        )
        expect(result.exitCode).toBe(2)
        expect(result.error).toContain("this host has no pinned-directory adapter")
        expect(result.verdict.verdict).toBe("not-reviewed")
        expect(result.outcome).toBeUndefined()
        expect(resolved).toBe(0)
        expect(reviewed).toBe(0)
        expect(yield* modelRequests(llm)).toHaveLength(0)
      }),
    { git: true },
    TIMEOUT,
  )

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

  linuxInstance(
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
        const baseSource = LIST_SOURCE.replace("index = items.length", "index=items.length-1")
        // A different size lets status report a change from stat data without invoking the clean filter.
        expect(Buffer.byteLength(baseSource)).toBe(Buffer.byteLength(LIST_SOURCE))
        yield* files.writeWithDirs(path.join(directory, "src/list.ts"), baseSource)
        yield* files.writeWithDirs(path.join(directory, ".gitattributes"), "*.ts filter=scope-provider-probe\n")
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
        const evidence = yield* tmpdirScoped()
        const counter = path.join(evidence, "filter-counter")
        const quoted = "'" + counter.replaceAll("'", "'\"'\"'") + "'"
        const command = `printf x >> ${quoted}; cat`
        yield* runGit(["config", "filter.scope-provider-probe.clean", command])
        yield* runGit(["config", "filter.scope-provider-probe.required", "true"])
        expect(yield* runGit(["rev-parse", "--show-toplevel"])).toBe(directory)
        expect(yield* runGit(["config", "--get", "filter.scope-provider-probe.clean"])).toBe(command)
        expect(yield* runGit(["check-attr", "filter", "--", "src/list.ts"])).toContain("scope-provider-probe")
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, ".gitattributes"), "utf8"))).toBe(
          "*.ts filter=scope-provider-probe\n",
        )
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "src/list.ts"), "utf8"))).toBe(LIST_SOURCE)
        yield* Effect.promise(() => fs.utimes(path.join(directory, "src/list.ts"), 1_900_000_001, 1_900_000_001))
        // The control is a real fixture-owned Git process, independent of any
        // engine wrapper policy; distinct mtimes defeat status-cache reuse.
        const control = yield* Effect.promise(() =>
          $`git -c core.fsmonitor=false status --porcelain`.cwd(directory).quiet().text(),
        )
        expect(control).toContain("src/list.ts")
        expect((yield* Effect.promise(() => fs.readFile(counter, "utf8"))).length).toBeGreaterThan(0)
        yield* Effect.promise(() => fs.writeFile(counter, ""))
        yield* Effect.promise(() => fs.utimes(path.join(directory, "src/list.ts"), 1_900_000_111, 1_900_000_111))
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
        expect(yield* Effect.promise(() => fs.readFile(counter, "utf8"))).toBe("")
        yield* llm.reset
        yield* runGit(["config", "include.path", "unsupported-review-config"])
        const unsupported = yield* runs
          .start({ ...request, requestID: "actual_provider_unsupported_git" }, source)
          .pipe(Effect.result)
        expect(Result.isFailure(unsupported)).toBe(true)
        expect(yield* modelRequests(llm)).toHaveLength(0)
        expect(yield* Effect.promise(() => fs.readFile(counter, "utf8"))).toBe("")
      }),
    { git: true },
    TIMEOUT,
  )

  linuxInstance(
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

  linuxInstance(
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

  linuxInstance(
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

  linuxInstance(
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

  linuxInstance(
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

  // VS-23c (SF-12b): under privacy "zdr" the review's scope is the zdr route's, which admission, the transport and the
  // session runtime enforce. A certificate made on the standard route does not apply, and one made on the zdr route
  // does.
  it.instance(
    "warn under zdr: a certificate applies only when it was made on the zdr route",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const warn = config({ modelEvidence: "warn", privacy: "zdr" })
        const model = {
          ...ref,
          context: 100_000,
          costKind: "priced" as const,
          subject: { model: "lmstudio/test-model", free: false, choice: { explicit: true, setting: "--model" } },
        }
        const standard = certificate(evidenceScope({ adapter: "engine", config: warn }))
        const routed = {
          ...certificate(evidenceScope({ adapter: "engine", config: warn, route: "zdr" })),
          route: "zdr" as const,
        }
        expect(certificateProblems(routed)).toEqual([])

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        const elsewhere = yield* Review.run(input(directory, { model, config: warn, certificates: [standard] }))
        expect(elsewhere.notes).toEqual([
          "The VectorScope evaluation of `lmstudio/test-model` on record (`vs-test`) was made with another privacy setting, so it does not apply here. Vector used it because --model names it, and does not switch a chosen model.",
        ])

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        const applied = yield* Review.run(input(directory, { model, config: warn, certificates: [routed] }))
        expect(applied.notes).toEqual([])
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

// VS-23b (SF-11): the route rules (core privacy.ts) at Review.run's admission. A loopback server is the only route a
// "zdr" review may use without an attestation, and no attestation source exists before SF-15, so the refused cases name
// models or providers off this computer, and the allowed ones run on the fake server.
describe("VS-23b route admission", () => {
  type Attempt = Extract<Review.Observation, { type: "attempt" }>
  const zdr = (overrides: Partial<ReviewConfig> = {}) => config({ privacy: "zdr", ...overrides })
  const fable = { providerID: ref.providerID, modelID: ModelV2.ID.make("claude-fable-5"), context: 100_000 } as const
  const attemptsOf = (observed: Review.Observation[]) =>
    observed.filter((event): event is Attempt => event.type === "attempt")
  const verdict = (outcome: ReviewOutcome) => reviewVerdict({ kind: "outcome", outcome })
  // What a refused review selects, in Review.run as in the CLI's refusal at resolution: nothing listed, no earlier
  // finding's bookkeeping, and no risk assessed.
  const unselected = {
    inline: [],
    outsideDiff: [],
    elsewhere: [],
    nits: [],
    overflow: [],
    stillOpen: [],
    fixed: [],
    dismissed: [],
    reappeared: [],
    raised: [],
    dropped: [],
    risk: "low" as const,
  }
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

  // The live model and provider the session's requests are built from, so a case can change the route mid-review as a
  // configuration change or a switch of model would. Restored when the case ends.
  const live = Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ref.providerID, ref.modelID).pipe(Effect.orDie)
    const info = yield* provider.getProvider(ref.providerID)
    const url = model.api.url
    const baseURL = info.options.baseURL
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        model.api.url = url
        info.options.baseURL = baseURL
      }),
    )
    return { model, info }
  })

  it.instance(
    "a refused review model sends nothing, is neither retried nor finalized, and leaves every file unreviewed",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const observed: Review.Observation[] = []
        const outcome = yield* Review.run(
          input(directory, {
            model: { ...fable, costKind: "priced" },
            config: zdr({ security: "always", verify: "blocking" }),
            prior: [open],
            observe: (event) => observed.push(event),
          }),
        )
        expect(yield* modelRequests(llm)).toEqual([])
        // An earlier blocking finding is neither listed as still open nor assessed: nothing was reviewed.
        expect(outcome.selection).toEqual(unselected)
        const attempts = attemptsOf(observed)
        expect(attempts.map((attempt) => attempt.pass).toSorted()).toEqual(["review", "security"])
        expect(attempts.every((attempt) => !attempt.admitted && attempt.stop === "privacy")).toBe(true)
        expect(attempts.every((attempt) => attempt.phase === "turn" && attempt.sessionID === undefined)).toBe(true)
        expect(outcome.sessions).toEqual([])
        expect(outcome.partial).toBe("privacy")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
        expect(outcome.specialists.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
          { name: "review", status: "stopped", steps: 0, detail: "privacy" },
          { name: "security", status: "stopped", steps: 0, detail: "privacy" },
        ])
        expect(outcome.notes).toEqual([
          notePrivacyRefused({ model: "lmstudio/claude-fable-5", refusal: "retention-required-model", attempts: 0 }),
        ])
        expect(verdict(outcome)).toEqual({ verdict: "not-reviewed", causes: ["privacy"], notes: [] })
      }),
    TIMEOUT,
  )

  it.instance(
    "a refused model of a triage pair stops the review before its cheaper first pass",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const observed: Review.Observation[] = []
        const outcome = yield* Review.run(
          input(directory, {
            model: { ...fable, costKind: "priced" },
            triage: { ...ref, context: 100_000, costKind: "priced" },
            config: zdr({ verify: "blocking" }),
            observe: (event) => observed.push(event),
          }),
        )
        expect(yield* modelRequests(llm)).toEqual([])
        expect(attemptsOf(observed).map((attempt) => [attempt.pass, attempt.admitted, attempt.stop])).toEqual([
          ["review", false, "privacy"],
        ])
        expect(outcome.partial).toBe("privacy")
        expect(outcome.notes).toEqual([
          notePrivacyRefused({ model: "lmstudio/claude-fable-5", refusal: "retention-required-model", attempts: 0 }),
        ])
      }),
    TIMEOUT,
  )

  it.instance(
    "a refused panel judge stops the review before any session, named in review.json or passed by the caller",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const refused = notePrivacyRefused({
          model: "lmstudio/claude-fable-5",
          refusal: "retention-required-model",
          attempts: 0,
        })
        // review.json's judgeModel is refused by its name before chooseModels would look it up: the test provider
        // lists no such model, so a lookup would find none and the review would run without a judge.
        const named = yield* Review.run(
          input(directory, { config: zdr({ panel: true, judgeModel: "lmstudio/claude-fable-5" }) }),
        )
        const passed = yield* Review.run(
          input(directory, { judge: { ...fable, costKind: "priced" }, config: zdr({ panel: true }) }),
        )
        for (const outcome of [named, passed]) {
          expect(outcome.sessions).toEqual([])
          expect(outcome.partial).toBe("privacy")
          expect(outcome.unreviewed).toEqual(["src/list.ts"])
          expect(outcome.specialists).toEqual([{ name: "review", status: "stopped", steps: 0, detail: "privacy" }])
          expect(outcome.notes).toEqual([refused])
        }
        expect(yield* modelRequests(llm)).toEqual([])
      }),
    TIMEOUT,
  )

  it.instance(
    "the free model a GitHub-shaped review falls back to is refused inside Review.run",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        // What resolveReviewModel resolves for an automatic run with no model set and a free model Vector offers.
        const free = {
          id: ModelV2.ID.make("acme/coder:free"),
          providerID: ProviderV2.ID.make("vector"),
          api: { id: "acme/coder:free", url: "", npm: "@ai-sdk/openai-compatible" },
          name: "Acme Coder (free)",
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
          release_date: "2025-01-01",
        } satisfies Provider.Model
        const fallback = yield* resolveReviewModel({ trigger: "auto", env: { VECTOR_CLI_TOKEN: "test-only" } }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Provider.Service, {
                list: () =>
                  Effect.succeed({
                    [free.providerID]: {
                      id: free.providerID,
                      name: "Vector",
                      env: [],
                      source: "api" as const,
                      options: {},
                      models: { [free.id]: free },
                    },
                  }),
                getModel: () => Effect.succeed(free),
                line: () => Effect.succeed(undefined),
              }),
              TestConfig.layer({ get: () => Effect.succeed({}), getGlobal: () => Effect.succeed({}) }),
              Layer.mock(ModelCatalog.Service, { get: () => Effect.succeed({}) }),
              Layer.mock(Auth.Service, { get: () => Effect.succeed(undefined) }),
            ),
          ),
        )
        expect(fallback).toMatchObject({ providerID: "vector", modelID: "acme/coder:free", costKind: "free" })
        const outcome = yield* Review.run(
          input(directory, { trigger: "auto", trust: "untrusted", model: fallback, config: zdr() }),
        )
        expect(yield* modelRequests(llm)).toEqual([])
        expect(outcome.sessions).toEqual([])
        expect(outcome.partial).toBe("privacy")
        expect(outcome.notes).toEqual([
          notePrivacyRefused({ model: "vector/acme/coder:free", refusal: "free-model", attempts: 0 }),
        ])
      }),
    TIMEOUT,
  )

  it.instance(
    "a provider in vector.json whose base URL nothing attests is refused before its session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const llm = yield* TestLLMServer
        const files = yield* FSUtil.Service
        const provider = testProviderConfig(llm.url)
        const remote = {
          ...provider.provider.lmstudio,
          name: "Remote",
          id: "remote",
          options: { apiKey: "test-key", baseURL: "https://remote.example.invalid/v1" },
        }
        yield* files.writeWithDirs(
          path.join(test.directory, "vector.json"),
          JSON.stringify({
            $schema: "https://vectordev.ai/config.json",
            ...provider,
            provider: { ...provider.provider, remote },
          }),
        )
        yield* files.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
        yield* Effect.promise(() => trustWorkspace(test.directory))
        const outcome = yield* Review.run(
          input(test.directory, {
            model: {
              providerID: ProviderV2.ID.make("remote"),
              modelID: ref.modelID,
              context: 100_000,
              costKind: "priced",
            },
            config: zdr(),
          }),
        )
        expect(yield* modelRequests(llm)).toEqual([])
        expect(outcome.sessions).toEqual([])
        expect(outcome.notes).toEqual([
          notePrivacyRefused({ model: "remote/test-model", refusal: "unattested-provider", attempts: 0 }),
        ])
      }),
    TIMEOUT,
  )

  it.instance(
    "a server on this computer is admitted under zdr, retries and finalizer included, and each session is registered",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const observed: Review.Observation[] = []
        const seen: (ReviewRoutes.Registered | undefined)[] = []
        const run = (overrides: Partial<Review.RunInput>) =>
          Review.run(
            input(directory, {
              observe: (event) => {
                observed.push(event)
                if (event.type === "attempt" && event.admitted && event.sessionID)
                  seen.push(ReviewRoutes.registered(event.sessionID))
              },
              ...overrides,
            }),
          )

        // A failed attempt and its retry.
        yield* llm.pushMatch(REVIEW, httpError(503, { error: "temporary failure" }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        const retried = yield* run({ config: zdr({ maxSteps: 2 }) })
        expect(retried.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
        expect(retried.partial).toBeUndefined()
        expect(retried.notes).toEqual([])
        expect(attemptsOf(observed).map((attempt) => [attempt.phase, attempt.admitted])).toEqual([
          ["turn", true],
          ["turn", true],
        ])
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(2)

        // An answer in prose, then the finalizer.
        observed.length = 0
        yield* llm.pushMatch(REVIEW, reply().text("I looked around.").stop())
        yield* llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report()))
        const finalized = yield* run({ config: zdr() })
        expect(finalized.specialists[0]).toMatchObject({ name: "review", status: "ok" })
        expect(attemptsOf(observed).map((attempt) => [attempt.phase, attempt.admitted])).toEqual([
          ["turn", true],
          ["finalize", true],
        ])

        // Every admitted attempt was in a session registered under the review's policy and its pass's agent, decided
        // as loopback; the registry is empty again once each review ends.
        expect(seen).toHaveLength(4)
        for (const entry of seen)
          expect(entry).toMatchObject({
            policy: { privacy: "zdr", attested: [] },
            agent: "review",
            decision: { allowed: true, kind: "loopback" },
          })
        for (const id of [...retried.sessions, ...finalized.sessions])
          expect(ReviewRoutes.registered(id)).toBeUndefined()
      }),
    TIMEOUT,
  )

  it.instance(
    "a model that changes after its first attempt is refused at the retry, and the pass is not finalized",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const { model } = yield* live
        const observed: Review.Observation[] = []
        yield* llm.pushMatch(REVIEW, httpError(503, { error: "temporary failure" }))
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        const outcome = yield* Review.run(
          input(directory, {
            config: zdr({ maxSteps: 2 }),
            observe: (event) => {
              observed.push(event)
              // The first attempt is sent and settles; the session's model then names another URL, as a switch would.
              // VS-23c (SF-12a): it changes once that attempt settled, not when it was admitted, since the transport
              // refuses an admitted attempt whose model changes before it is sent (zdr-route.test.ts).
              if (event.type === "settle") model.api.url = "https://moved.example.invalid/v1"
            },
          }),
        )
        expect((yield* llm.hits).filter(REVIEW)).toHaveLength(1)
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
        const attempts = attemptsOf(observed)
        expect(attempts.map((attempt) => [attempt.phase, attempt.admitted, attempt.stop])).toEqual([
          ["turn", true, undefined],
          ["turn", false, "privacy"],
        ])
        expect(outcome.specialists).toEqual([{ name: "review", status: "stopped", steps: 0, detail: "privacy" }])
        expect(outcome.partial).toBe("privacy")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
        expect(outcome.notes).toEqual([
          notePrivacyRefused({ model: "lmstudio/test-model", refusal: "unknown-destination", attempts: 1 }),
        ])
      }),
    TIMEOUT,
  )

  it.instance(
    "a model that changes before the finalizer is refused at the finalizer's attempt",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const { model } = yield* live
        const observed: Review.Observation[] = []
        yield* llm.pushMatch(REVIEW, reply().text("I looked around.").stop())
        yield* llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report()))
        const outcome = yield* Review.run(
          input(directory, {
            config: zdr(),
            observe: (event) => {
              observed.push(event)
              // Once the turn's attempt settled (VS-23c: not when it was admitted, as above).
              if (event.type === "settle") model.api.url = "https://moved.example.invalid/v1"
            },
          }),
        )
        expect((yield* llm.hits).filter(FINALIZE)).toHaveLength(0)
        expect(attemptsOf(observed).map((attempt) => [attempt.phase, attempt.admitted, attempt.stop])).toEqual([
          ["turn", true, undefined],
          ["finalize", false, "privacy"],
        ])
        expect(outcome.specialists).toEqual([{ name: "review", status: "stopped", steps: 1, detail: "privacy" }])
        expect(outcome.partial).toBe("privacy")
        expect(outcome.notes).toEqual([
          notePrivacyRefused({ model: "lmstudio/test-model", refusal: "unknown-destination", attempts: 1 }),
        ])
      }),
    TIMEOUT,
  )

  it.instance(
    "a route refused before the verify pass stops it before its session, and the review lists no finding",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const { info } = yield* live
        const observed: Review.Observation[] = []
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
        const outcome = yield* Review.run(
          input(directory, {
            config: zdr({ verify: "blocking" }),
            observe: (event) => observed.push(event),
            // Once the review pass is done, the provider's base URL moves off this computer.
            onProgress: (event) => {
              if (event.type === "specialist" && event.name === "review" && event.status === "ok")
                info.options.baseURL = "https://moved.example.invalid/v1"
            },
          }),
        )
        expect((yield* llm.hits).filter(VERIFY)).toHaveLength(0)
        expect(outcome.sessions).toHaveLength(1)
        expect(
          attemptsOf(observed).map((attempt) => [attempt.pass, attempt.phase, attempt.admitted, attempt.stop]),
        ).toEqual([
          ["review", "turn", true, undefined],
          ["verify", "turn", false, "privacy"],
        ])
        expect(outcome.specialists).toEqual([
          { name: "review", status: "ok", steps: 1 },
          { name: "verify", status: "stopped", steps: 0, detail: "privacy" },
        ])
        expect(outcome.partial).toBe("privacy")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
        // The review pass's finding was never verified, and nothing finished stands behind it.
        expect(outcome.report.findings).toEqual([])
        expect(listedCount(outcome)).toBe(0)
        expect(outcome.notes).toEqual([
          notePrivacyRefused({ model: "lmstudio/test-model", refusal: "unattested-provider", attempts: 1 }),
        ])
        expect(verdict(outcome).verdict).toBe("not-reviewed")
      }),
    TIMEOUT,
  )

  it.instance(
    "D3: unset, standard and zdr on this computer send the same requests and return the same outcome",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        // Each scenario's replies, made fresh for every run.
        const scenarios: { name: string; config: Partial<ReviewConfig>; push: () => Effect.Effect<void> }[] = [
          { name: "ok", config: {}, push: () => llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report())) },
          {
            name: "retry",
            config: { maxSteps: 2 },
            push: () =>
              llm
                .pushMatch(REVIEW, httpError(503, { error: "temporary failure" }))
                .pipe(Effect.andThen(llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report())))),
          },
          {
            name: "finalizer",
            config: {},
            push: () =>
              llm
                .pushMatch(REVIEW, reply().text("I looked around.").stop())
                .pipe(Effect.andThen(llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report())))),
          },
          {
            name: "verify",
            config: { verify: "blocking" },
            push: () =>
              llm
                .pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
                .pipe(Effect.andThen(llm.pushMatch(VERIFY, reply().tool("StructuredOutput", { results: [] })))),
          },
        ]
        for (const scenario of scenarios) {
          const runs = yield* Effect.forEach([undefined, "standard", "zdr"] as const, (privacy) =>
            Effect.gen(function* () {
              yield* llm.reset
              yield* scenario.push()
              const outcome = yield* Review.run(
                input(directory, {
                  model: priced,
                  config: config({ ...scenario.config, ...(privacy ? { privacy } : {}) }),
                }),
              )
              const { durationMs: _duration, sessions: _sessions, ...rest } = outcome
              return { bodies: (yield* modelRequests(llm)).map((body) => JSON.stringify(body)), outcome: rest }
            }),
          )
          expect({ name: scenario.name, run: runs[1] }).toEqual({ name: scenario.name, run: runs[0] })
          expect({ name: scenario.name, run: runs[2] }).toEqual({ name: scenario.name, run: runs[0] })
          expect(runs[0]!.bodies.length).toBeGreaterThan(0)
        }
      }),
    120_000,
  )

  it.instance(
    "VS-23c: an attested OpenRouter account the configuration defines is sent the ZDR body by the transport",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        // A provider defined in configuration on the OpenRouter SDK, at the fake server as its stand-in. The catalog
        // ships it nowhere (`catalogOrigins` []), so its ID attests the owner's OpenRouter account. Only admission
        // knows that; the transport decides on what admission decided on (`decidedOn`), and without it would refuse the
        // route as "unattested-openrouter".
        const base = testProviderConfig(llm.url)
        const files = yield* FSUtil.Service
        yield* files.writeWithDirs(
          path.join(directory, "vector.json"),
          JSON.stringify({
            $schema: "https://vectordev.ai/config.json",
            ...base,
            provider: {
              myrouter: {
                ...base.provider.lmstudio,
                id: "myrouter",
                name: "My router",
                npm: "@openrouter/ai-sdk-provider",
                models: { "test-model": { ...base.provider.lmstudio.models["test-model"], cost: PRICE } },
              },
            },
          }),
        )
        yield* Effect.promise(() => trustWorkspace(directory))
        const model = {
          providerID: ProviderV2.ID.make("myrouter"),
          modelID: ref.modelID,
          context: 100_000,
          costKind: "priced" as const,
          price: PRICE,
          catalogOrigins: [],
        }
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        const outcome = yield* Review.run(input(directory, { model, config: zdr({ zdrAttested: ["myrouter"] }) }))
        expect(outcome.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
        expect(outcome.partial).toBeUndefined()
        const bodies = yield* modelRequests(llm)
        expect(bodies.length).toBeGreaterThan(0)
        for (const body of bodies) expect(body.provider).toEqual({ zdr: true, data_collection: "deny" })
      }),
    TIMEOUT,
  )

  // VS-23c (SF-12b): a "zdr" review's history is never summarised. The overflow that would start a compaction ends the
  // pass at the loop's top instead (prompt.ts, as a pinned review does), so neither the compaction agent's request nor
  // another attempt is sent, and the pass fails with the reason. The control under privacy unset sends the summary.
  it.instance(
    "VS-23c (SF-12b): a zdr review never summarises a pass's history, and the pass fails with the reason",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const observed: Review.Observation[] = []
        const overflow = () => httpError(400, { type: "error", error: { code: "context_length_exceeded" } })
        yield* llm.pushMatch(REVIEW, overflow())
        const outcome = yield* Review.run(
          input(directory, { config: zdr({ maxSteps: 3 }), observe: (event) => observed.push(event) }),
        )
        const hits = yield* llm.hits
        expect(hits).toHaveLength(1)
        expect(hits.filter(REVIEW)).toHaveLength(1)
        expect(hits.filter(SUMMARY)).toHaveLength(0)
        expect(hits.filter(FINALIZE)).toHaveLength(0)
        expect(outcome.specialists).toHaveLength(1)
        expect(outcome.specialists[0]).toMatchObject({
          name: "review",
          status: "failed",
          detail:
            'Review incomplete: This review\'s privacy is "zdr", so its history is never summarised, and nothing more was sent. Review fewer files at once, or use a model with a larger context.',
        })
        expect(outcome.partial).toBe("model-error")
        expect(outcome.unreviewed).toEqual(["src/list.ts"])
        expect(attemptsOf(observed).map((attempt) => [attempt.phase, attempt.admitted])).toEqual([["turn", true]])

        // The control: the same overflow under privacy unset is summarised, in one compaction request.
        yield* llm.reset
        yield* llm.pushMatch(REVIEW, overflow())
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        yield* Review.run(input(directory, { config: config({ maxSteps: 3 }) }))
        expect((yield* llm.hits).filter(SUMMARY)).toHaveLength(1)
      }),
    TIMEOUT,
  )

  // VS-23c (SF-12b), the proof that every request a "zdr" review sends is one of its passes' own: a retried turn, a
  // finalizer and the verify pass. Each names, in its session header, a session the review created, and none is a title,
  // memory learner, skill drafter or compaction request. Under privacy unset the same review sends the same kinds. A
  // title-shaped request on a session the review has released is refused by the session runtime, and sends nothing.
  it.instance(
    "VS-23c (SF-12b): every request of a zdr review names a session the review created, and none is a helper's",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        const KINDS = [REVIEW, SECURITY, FINALIZE, VERIFY]
        const reviewed = (privacy?: "zdr") =>
          Effect.gen(function* () {
            yield* llm.reset
            yield* llm.pushMatch(REVIEW, httpError(503, { error: "temporary failure" }))
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
            yield* llm.pushMatch(SECURITY, reply().text("I looked around.").stop())
            yield* llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report()))
            yield* llm.pushMatch(VERIFY, reply().tool("StructuredOutput", { results: [] }))
            const settings = { security: "always" as const, verify: "blocking" as const, maxSteps: 2 }
            const outcome = yield* Review.run(input(directory, { config: privacy ? zdr(settings) : config(settings) }))
            return { outcome, hits: yield* llm.hits }
          })
        const zdrRun = yield* reviewed("zdr")
        const unset = yield* reviewed()
        const kinds = (hits: typeof zdrRun.hits) =>
          hits.map((hit) => KINDS.findIndex((kind) => kind(hit))).toSorted((a, b) => a - b)
        expect(zdrRun.outcome.specialists.map((entry) => [entry.name, entry.status])).toEqual(
          unset.outcome.specialists.map((entry) => [entry.name, entry.status]),
        )
        expect(kinds(zdrRun.hits)).toEqual(kinds(unset.hits))
        expect(kinds(zdrRun.hits)).not.toContain(-1)
        // The retry, the finalizer and the verify pass all ran.
        expect(zdrRun.hits.filter(REVIEW)).toHaveLength(2)
        expect(zdrRun.hits.filter(FINALIZE)).toHaveLength(1)
        expect(zdrRun.hits.filter(VERIFY)).toHaveLength(1)
        const helpers = [
          "Generate a title for this conversation",
          BrainLearn.PROMPT.split("\n")[0]!,
          BrainSkill.PROMPT.split("\n")[0]!,
          buildPrompt({ context: [] }).split("\n")[0]!,
        ]
        for (const hit of zdrRun.hits) {
          expect(hit.session).toBeDefined()
          expect(Schema.is(SessionID)(hit.session)).toBe(true)
          expect(zdrRun.outcome.sessions).toContain(hit.session!)
          for (const helper of helpers) expect(hit.text).not.toContain(helper)
        }

        // A title-shaped request on a released session of the zdr review: refused, and nothing sent.
        const runtime = yield* LLM.Service
        const provider = yield* Provider.Service
        const found = yield* provider.getModel(ref.providerID, ref.modelID).pipe(Effect.orDie)
        const sessionID = zdrRun.outcome.sessions[0]!
        const before = (yield* llm.hits).length
        const late = yield* runtime
          .stream({
            user: {
              id: MessageID.make("msg_lateTitleAfterRelease"),
              sessionID: SessionID.make(sessionID),
              role: "user",
              time: { created: 1 },
              agent: "title",
              model: { providerID: found.providerID, modelID: found.id },
            },
            sessionID,
            model: found,
            agent: { name: "title", mode: "primary", options: {}, permission: [] },
            system: [],
            small: true,
            purpose: "title",
            tools: {},
            messages: [{ role: "user", content: "Generate a title for this conversation:\n" }],
          })
          .pipe(Stream.runDrain, Effect.exit)
        const error = Exit.isFailure(late) ? Cause.squash(late.cause) : undefined
        expect(error).toBeInstanceOf(ReviewRoutes.Refused)
        expect((error as ReviewRoutes.Refused).site).toBe("session")
        expect((yield* llm.hits).length).toBe(before)
      }),
    60_000,
  )

  // VS-23c (SF-12b): the agent a pass is registered with is the one Review.run prompts it with, whatever the review's
  // identity, so a pinned review and a VectorScope-identity review send their turns under zdr as before.
  it.instance(
    "VS-23c (SF-12b): a pinned review and a VectorScope-identity review are registered with their agent and sent",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer()
        for (const identity of [undefined, VECTORSCOPE_AGENT] as const) {
          yield* llm.reset
          yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
          const seen: (ReviewRoutes.Registered | undefined)[] = []
          const outcome = yield* Review.run(
            input(directory, {
              ...(identity ? { identity } : {}),
              instructionsFromContext: true,
              context: { instructions: "PINNED_BASE_INSTRUCTIONS_MARKER" },
              config: zdr(),
              observe: (event) => {
                if (event.type === "attempt" && event.admitted && event.sessionID)
                  seen.push(ReviewRoutes.registered(event.sessionID))
              },
            }),
          )
          expect(outcome.specialists).toEqual([{ name: "review", status: "ok", steps: 1 }])
          expect(outcome.partial).toBeUndefined()
          expect(yield* modelRequests(llm)).toHaveLength(1)
          expect(seen).toHaveLength(1)
          expect(seen[0]).toMatchObject({ policy: { privacy: "zdr" }, agent: identity ?? "review" })
        }
      }),
    TIMEOUT,
  )
})

describe("VS-34 holdback payload (SF-13b)", () => {
  // A credential file holdbackFiles holds back under "secrets" (CREDENTIAL_FILES, core review/permission.ts) that is
  // not a sensitive path, so the plan stays the review pass alone.
  const NETRC = parseUnifiedDiff(
    [
      "diff --git a/deploy/.netrc b/deploy/.netrc",
      "--- a/deploy/.netrc",
      "+++ b/deploy/.netrc",
      "@@ -1 +1 @@",
      "-machine registry.example.test login old-ci",
      "+machine registry.example.test login ci",
    ].join("\n"),
  )
  const ENV_DELETION = parseUnifiedDiff(
    [
      "diff --git a/.env b/.env",
      "deleted file mode 100644",
      "--- a/.env",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-API_URL=https://api.example.test",
    ].join("\n"),
  )
  // Token shapes the shapes reading redacts, assembled at run time so no token-like literal sits in the source: one per
  // untrusted block, so each block's redaction is asserted on its own.
  const T = {
    related: "ghp_" + "r1E2".repeat(9),
    history: "glpat-" + "h1I2s3T4o5R6y7Z8w9X0",
    comment: "xoxb-" + "1234567890-" + "c1O2m3M4e5N6",
    title: "sk-" + "t1I2".repeat(8),
    body: "AKIA" + "B7Q2W4E6R8T0Y1U3",
    commit: "npm_" + "c7O8".repeat(9),
    requirements: "hf_" + "q9R0".repeat(8),
    head: "ghp_" + "h3E4".repeat(9),
    diff: "sk-proj-" + "d7I8".repeat(8),
  }
  const added = (file: string, lines: string[]) =>
    parseUnifiedDiff(
      [
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${file}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
      ].join("\n"),
    )
  const strip = (outcome: ReviewOutcome) => {
    const { durationMs: _duration, sessions: _sessions, ...rest } = outcome
    return rest
  }

  // I-1 at the wire: unset and "off" send byte-identical requests under the same permission rules and return the same
  // outcome, with no input-redaction sentence. Under "secrets" the credential file is held back (absent from every
  // request body), recorded as a held-back skip with its status, never unreviewed, the review and security prompts
  // carry the sentence, and the permission rules are unset's with exactly the read denies SF-14 adds: the credential
  // list and the held path.
  it.instance(
    "D3: unset and off send what they did, and secrets holds the credential file back",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const sessions = yield* Session.Service
        const files = [...LIST, ...NETRC]
        const scenarios: { name: string; config: Partial<ReviewConfig>; push: () => Effect.Effect<void> }[] = [
          { name: "ok", config: {}, push: () => llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report())) },
          {
            name: "retry",
            config: { maxSteps: 2 },
            push: () =>
              llm
                .pushMatch(REVIEW, httpError(503, { error: "temporary failure" }))
                .pipe(Effect.andThen(llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report())))),
          },
          {
            name: "finalizer",
            config: {},
            push: () =>
              llm
                .pushMatch(REVIEW, reply().text("I looked around.").stop())
                .pipe(Effect.andThen(llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report())))),
          },
          {
            name: "verify",
            config: { verify: "blocking" },
            push: () =>
              llm
                .pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
                .pipe(Effect.andThen(llm.pushMatch(VERIFY, reply().tool("StructuredOutput", { results: [] })))),
          },
        ]
        for (const scenario of scenarios) {
          const runs = yield* Effect.forEach([undefined, "off", "secrets"] as const, (holdback) =>
            Effect.gen(function* () {
              yield* llm.reset
              yield* scenario.push()
              const outcome = yield* Review.run(
                input(directory, {
                  model: priced,
                  files,
                  anchors: files,
                  config: config({ ...scenario.config, ...(holdback ? { holdback } : {}) }),
                }),
              )
              const rules = yield* Effect.forEach(outcome.sessions, (id) =>
                sessions.get(SessionID.make(id)).pipe(Effect.map((session) => session.permission)),
              )
              return { bodies: (yield* modelRequests(llm)).map((body) => JSON.stringify(body)), rules, outcome }
            }),
          )
          const [unset, off, secrets] = runs
          expect({ name: scenario.name, run: { ...off, outcome: strip(off.outcome) } }).toEqual({
            name: scenario.name,
            run: { ...unset, outcome: strip(unset.outcome) },
          })
          expect(unset.bodies.length).toBeGreaterThan(0)
          expect(unset.rules.length).toBeGreaterThan(0)
          expect(unset.bodies.some((body) => body.includes("deploy/.netrc"))).toBe(true)
          expect([...unset.bodies, ...off.bodies].some((body) => body.includes(INPUT_REDACTION))).toBe(false)
          expect(unset.outcome.skipped).toEqual([])
          expect(unset.outcome.held).toBeUndefined()
          // Secrets: unset's rules plus the read denies alone, the same passes, the credential file nowhere in what was
          // sent.
          const added = [...CREDENTIAL_FILES, "deploy/.netrc"].map((pattern) => ({
            permission: "read",
            pattern,
            action: "deny" as const,
          }))
          expect({
            name: scenario.name,
            rules: secrets.rules.map((rules) =>
              rules?.filter((rule) => !added.some((deny) => Bun.deepEquals(deny, rule))),
            ),
          }).toEqual({ name: scenario.name, rules: unset.rules })
          for (const rules of secrets.rules) {
            for (const deny of added) expect(rules).toContainEqual(deny)
            expect(holdsBack(rules)).toBe(true)
          }
          for (const rules of unset.rules) expect(holdsBack(rules)).toBe(false)
          expect(secrets.bodies.length).toBe(unset.bodies.length)
          expect(secrets.bodies.some((body) => body.includes(INPUT_REDACTION))).toBe(true)
          expect(secrets.bodies.filter((body) => body.includes("deploy/.netrc") || body.includes("login ci"))).toEqual(
            [],
          )
          expect(secrets.outcome.skipped).toEqual([{ path: "deploy/.netrc", reason: "held-back" }])
          expect(secrets.outcome.held).toEqual([
            { path: "deploy/.netrc", status: "modified", reason: "credential-file" },
          ])
          expect(secrets.outcome.unreviewed).toEqual([])
          expect(secrets.outcome.specialists).toEqual(unset.outcome.specialists)
          expect(secrets.outcome.stats).toEqual(unset.outcome.stats)
          // No ignore list was passed, so the review says it could not check one. Holdback's notes come before the
          // cost and evidence notes; a trusted review's held note says only what left the prompt (SF-14).
          expect(secrets.outcome.notes).toEqual([
            noteHeldBack(["deploy/.netrc"], { promptOnly: true })!,
            noteIgnoreUnchecked(),
            ...unset.outcome.notes,
          ])
          expect(unset.outcome.specialists.map((entry) => entry.name)).not.toContain("security")
          expect(reviewVerdict({ kind: "outcome", outcome: secrets.outcome }).causes).toContain("held-back")
        }
      }),
    120_000,
  )

  // Design item 3 at the wire: a token planted in each untrusted block, the diff of a file that is sent and an
  // untrusted head file included, reaches no request body under "secrets" (the review, security and verify passes),
  // where "[redacted]" stands in; unset, every one of them is sent as before.
  it.instance(
    "secrets redacts every untrusted block in every pass's request, and unset sends them as before",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const files = [...AUTH, ...LIST, ...added("src/config.ts", [`export const key = "${T.diff}"`])]
        const runs = yield* Effect.forEach([undefined, "secrets"] as const, (holdback) =>
          Effect.gen(function* () {
            yield* llm.reset
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding()])))
            yield* llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()))
            yield* llm.pushMatch(VERIFY, reply().tool("StructuredOutput", { results: [] }))
            const outcome = yield* Review.run(
              input(directory, {
                model: priced,
                trust: "untrusted",
                files,
                anchors: files,
                headFiles: [{ path: "src/list.ts", text: `${LIST_SOURCE}// ${T.head}\n`, exact: true }],
                context: {
                  related: [
                    {
                      symbol: "last",
                      path: "src/list.ts",
                      hits: [{ path: "src/use.ts", line: 3, text: `last(load("${T.related}"))` }],
                    },
                  ],
                  history: [{ path: "src/list.ts", text: `abc1234 octo 2026-11-01 Use ${T.history}` }],
                  humanComments: [{ author: "octo", path: "src/list.ts", line: 2, body: `Try ${T.comment}` }],
                  requirements: `The list reads ${T.requirements}.`,
                },
                pr: { number: 7, title: `Fix ${T.title}`, body: `Uses ${T.body}`, author: "octo", commits: [T.commit] },
                config: config({ verify: "blocking", ...(holdback ? { holdback } : {}) }),
              }),
            )
            return { bodies: (yield* modelRequests(llm)).map((body) => JSON.stringify(body)), outcome }
          }),
        )
        const [unset, secrets] = runs
        // The review, security and verify passes ran both times.
        for (const run of runs)
          expect(run.outcome.specialists.map((entry) => entry.name)).toEqual(["review", "security", "verify"])
        for (const [name, value] of Object.entries(T)) {
          expect({ name, unset: unset.bodies.some((body) => body.includes(value)) }).toEqual({ name, unset: true })
          expect({ name, secrets: secrets.bodies.filter((body) => body.includes(value)).length }).toEqual({
            name,
            secrets: 0,
          })
        }
        // The security prompt names the placeholder for the model's own output either way; holdback adds its own.
        const placeholders = (bodies: string[]) => bodies.join("").split("[redacted]").length - 1
        expect(placeholders(secrets.bodies)).toBeGreaterThan(placeholders(unset.bodies) + Object.keys(T).length)
        // Nothing was held, so nothing is skipped; the redacted files are noted.
        expect(secrets.outcome.skipped).toEqual([])
        expect(secrets.outcome.held).toBeUndefined()
        expect(secrets.outcome.notes).toContain(noteRedacted(["src/list.ts", "src/config.ts"])!)
      }),
    120_000,
  )

  // Design item 5: a held file is skipped, never unreviewed, however the run ends, so a re-trigger on the same head
  // still takes the already-reviewed skip.
  it.instance(
    "a held file is skipped and never unreviewed, on a full, partial or failed run",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const file = path.join(directory, "src/list.ts")
        const files = [...LIST, ...NETRC]
        const scenarios: { name: string; config: Partial<ReviewConfig>; push: () => Effect.Effect<void> }[] = [
          { name: "ok", config: {}, push: () => llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report())) },
          {
            name: "steps, finalized",
            config: { maxSteps: 2 },
            push: () =>
              llm
                .pushMatch(REVIEW, reply().tool("read", { filePath: file }))
                .pipe(
                  Effect.andThen(llm.pushMatch(REVIEW, reply().tool("read", { filePath: file }))),
                  Effect.andThen(llm.pushMatch(FINALIZE, reply().tool("StructuredOutput", report()))),
                ),
          },
          {
            name: "no report",
            config: { maxSteps: 1 },
            push: () =>
              llm
                .pushMatch(REVIEW, httpError(503, { error: "temporary failure" }))
                .pipe(Effect.andThen(llm.pushMatch(FINALIZE, httpError(503, { error: "temporary failure" })))),
          },
        ]
        for (const scenario of scenarios) {
          yield* llm.reset
          yield* scenario.push()
          const outcome = yield* Review.run(
            input(directory, {
              model: priced,
              files,
              anchors: files,
              config: config({ ...scenario.config, holdback: "secrets" }),
            }),
          )
          expect({ name: scenario.name, skipped: outcome.skipped }).toEqual({
            name: scenario.name,
            skipped: [{ path: "deploy/.netrc", reason: "held-back" }],
          })
          expect(outcome.unreviewed).not.toContain("deploy/.netrc")
          const state = nextState(undefined, {
            head: outcome.head,
            base: outcome.base,
            mode: "full",
            now: 1,
            unreviewed: outcome.unreviewed,
          })
          const skip = decideSkip({
            trigger: "auto",
            config: DEFAULT_REVIEW_CONFIG,
            state,
            head: outcome.head,
            pr: { draft: false, author: "octo", labels: [], headBranch: "feature", fork: false },
            size: { files: files.length, changedLines: 4 },
          })
          expect({ name: scenario.name, reason: skip.skip ? skip.reason : undefined }).toEqual({
            name: scenario.name,
            reason: outcome.unreviewed.length ? undefined : "already-reviewed",
          })
        }
      }),
    120_000,
  )

  // Design item 4: the collector's check-ignore list becomes a note, never a drop: the ignored file is still sent, with
  // its values redacted. A held deletion beside it sent nothing, so VS-32 reads the review complete.
  it.instance(
    "names a committed ignored file, still sends it redacted, and a held deletion reads complete",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const local = added("config.local.json", [`{ "token": "${T.diff}" }`])
        const files = [...LIST, ...local, ...ENV_DELETION]
        // A held .env is still a sensitive path, so the plan keeps its security pass: holdback never lowers the passes.
        const push = () =>
          llm
            .pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
            .pipe(Effect.andThen(llm.pushMatch(SECURITY, reply().tool("StructuredOutput", report()))))
        yield* push()
        const outcome = yield* Review.run(
          input(directory, {
            model: priced,
            files,
            anchors: files,
            ignored: ["config.local.json"],
            config: config({ holdback: "secrets" }),
          }),
        )
        const bodies = (yield* modelRequests(llm)).map((body) => JSON.stringify(body))
        expect(outcome.specialists).toEqual([
          { name: "review", status: "ok", steps: 1 },
          { name: "security", status: "ok", steps: 1 },
        ])
        expect(bodies.some((body) => body.includes("config.local.json"))).toBe(true)
        expect(bodies.some((body) => body.includes(T.diff) || body.includes("API_URL"))).toBe(false)
        expect(outcome.skipped).toEqual([{ path: ".env", reason: "held-back" }])
        expect(outcome.held).toEqual([{ path: ".env", status: "deleted", reason: "env-file" }])
        // Holdback's notes, before the cost note the fake provider's missing usage adds.
        const own = (notes: string[]) => notes.filter((note) => !note.startsWith("Reported cost may be incomplete"))
        expect(own(outcome.notes)).toEqual([
          noteHeldBack([".env"], { promptOnly: true })!,
          noteRedacted(["config.local.json"])!,
          noteIgnoredCommitted(["config.local.json"])!,
        ])
        expect(reviewVerdict({ kind: "outcome", outcome })).toEqual({
          verdict: "clean-complete",
          causes: [],
          notes: ["held-back-deletion"],
        })
        // An empty list means the collector checked and found none: no note either way.
        yield* llm.reset
        yield* push()
        const checked = yield* Review.run(
          input(directory, {
            model: priced,
            files,
            anchors: files,
            ignored: [],
            config: config({ holdback: "secrets" }),
          }),
        )
        expect(own(checked.notes)).toEqual([
          noteHeldBack([".env"], { promptOnly: true })!,
          noteRedacted(["config.local.json"])!,
        ])
      }),
    TIMEOUT,
  )

  // When every changed file is held back nothing is left to send, so no pass runs and nothing is spent: the files are
  // skipped, and with no reviewer VS-32 reads the review incomplete, a deletion-only change included (decided in the
  // SF-13b entry). Unset, the same change runs its review pass.
  it.instance(
    "a change whose every file is held back runs no pass",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        for (const files of [NETRC, ENV_DELETION]) {
          yield* llm.reset
          const outcome = yield* Review.run(
            input(directory, { model: priced, files, anchors: files, config: config({ holdback: "secrets" }) }),
          )
          expect(yield* modelRequests(llm)).toEqual([])
          expect(outcome.specialists).toEqual([])
          expect(outcome.sessions).toEqual([])
          expect(outcome.unreviewed).toEqual([])
          expect(outcome.skipped).toEqual([{ path: files[0].path, reason: "held-back" }])
          expect(outcome.held?.map((file) => file.status)).toEqual([files[0].status])
          const verdict = reviewVerdict({ kind: "outcome", outcome })
          expect(verdict.verdict).toBe("incomplete")
          expect(verdict.causes).toEqual(files === NETRC ? ["held-back", "no-reviewer"] : ["no-reviewer"])
        }
        yield* llm.reset
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        const unset = yield* Review.run(input(directory, { model: priced, files: NETRC, anchors: NETRC }))
        expect(unset.specialists.map((entry) => entry.name)).toEqual(["review"])
      }),
    TIMEOUT,
  )

  // A finding the reviewer reports on a held path is never quoted to the verify pass, and selection drops it.
  it.instance(
    "a finding on a held path never reaches verify, and is not listed",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const files = [...LIST, ...NETRC]
        const held = finding({ path: "deploy/.netrc", line: 1, title: "Committed registry login for HELDMARK" })
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report([finding(), held])))
        yield* llm.pushMatch(VERIFY, reply().tool("StructuredOutput", { results: [] }))
        const outcome = yield* Review.run(
          input(directory, {
            model: priced,
            files,
            anchors: files,
            config: config({ verify: "blocking", holdback: "secrets" }),
          }),
        )
        const verify = (yield* llm.inputs).filter((body) => VERIFY({ body })).map((body) => JSON.stringify(body))
        expect(verify).toHaveLength(1)
        expect(verify[0]).toContain("Returns undefined for the last item")
        expect(verify[0]).not.toContain("HELDMARK")
        expect(listedCount(outcome)).toBe(1)
        expect(outcome.selection.dropped).toContainEqual({ reason: "ignored-path", count: 1 })
      }),
    TIMEOUT,
  )
  // Design item 3 for the earlier findings the review prompt lists as open: one on a held path is in no request body
  // and gets no status from the model, so neither an untriaged run (whose word the CLI settles) nor a triaged one (whose
  // claim the verify pass checks) can close it; another has its model-written title redacted. Selection keeps both open
  // from the input. Unset, both are listed and the model's word stands, as before.
  it.instance(
    "an earlier finding on a held path is never quoted to the model, and the model's status for it is dropped",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        // A cheaper triage model beside the review model, as the triage tests above set one up.
        const fsUtil = yield* FSUtil.Service
        const provider = testProviderConfig(llm.url)
        provider.provider.lmstudio.models["test-model"].cost = PRICE
        Object.assign(provider.provider.lmstudio.models, {
          "cheap-model": { ...provider.provider.lmstudio.models["test-model"], id: "cheap-model", name: "Cheap" },
        })
        yield* fsUtil.writeWithDirs(
          path.join(directory, "vector.json"),
          JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...provider }),
        )
        yield* Effect.promise(() => trustWorkspace(directory))
        const cheap = { ...ref, modelID: ModelV2.ID.make("cheap-model"), context: 100_000, costKind: "free" as const }
        const files = [...LIST, ...NETRC]
        const earlier = (id: string, file: string, title: string) => ({
          id,
          where: "inline" as const,
          path: file,
          line: 1,
          side: "RIGHT" as const,
          severity: "blocking" as const,
          category: "security" as const,
          title,
          sha: "1111111",
          status: "open" as const,
        })
        const prior = [
          earlier("aaaaaaaaaaaa", "src/list.ts", `Hard-coded ${T.title}`),
          earlier("bbbbbbbbbbbb", "deploy/.netrc", "Committed registry login for HELDMARK"),
        ]
        const claimed = {
          ...report(),
          priorStatus: prior.map((entry) => ({ id: entry.id, status: "fixed", reason: "looks fine" })),
        }
        const runs = yield* Effect.forEach([undefined, "secrets"] as const, (holdback) =>
          Effect.gen(function* () {
            yield* llm.reset
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", claimed))
            const outcome = yield* Review.run(
              input(directory, {
                model: priced,
                files,
                anchors: files,
                prior,
                config: config(holdback ? { holdback } : {}),
              }),
            )
            return { bodies: (yield* modelRequests(llm)).map((body) => JSON.stringify(body)), outcome }
          }),
        )
        const [unset, secrets] = runs
        expect(unset.bodies.some((body) => body.includes("bbbbbbbbbbbb") && body.includes("HELDMARK"))).toBe(true)
        expect(unset.bodies.some((body) => body.includes(T.title))).toBe(true)
        expect(unset.outcome.report.priorStatus?.map((entry) => entry.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"])
        expect(secrets.bodies.length).toBeGreaterThan(0)
        expect(secrets.bodies.filter((body) => body.includes("bbbbbbbbbbbb") || body.includes("HELDMARK"))).toEqual([])
        expect(secrets.bodies.filter((body) => body.includes(T.title))).toEqual([])
        expect(secrets.bodies.some((body) => body.includes("Hard-coded [redacted]"))).toBe(true)
        expect(secrets.outcome.report.priorStatus?.map((entry) => entry.id)).toEqual(["aaaaaaaaaaaa"])
        expect(secrets.outcome.selection.stillOpen).toEqual(unset.outcome.selection.stillOpen)

        // After a cheaper triage pass a fixed claim goes to the verify pass: only the listed one, with its title as
        // listed, and the held one's claim is dropped before it.
        yield* llm.reset
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", claimed))
        yield* llm.pushMatch(VERIFY, reply().tool("StructuredOutput", { results: [] }))
        const triaged = yield* Review.run(
          input(directory, {
            model: priced,
            triage: cheap,
            files,
            anchors: files,
            prior,
            config: config({ verify: "all", holdback: "secrets" }),
          }),
        )
        const verify = (yield* llm.inputs).filter((body) => VERIFY({ body })).map((body) => JSON.stringify(body))
        expect(verify).toHaveLength(1)
        expect(verify[0]).toContain('untrusted_fixed_claim id=\\"aaaaaaaaaaaa\\"')
        expect(verify[0]).toContain("Hard-coded [redacted]")
        expect(verify[0]).not.toContain("bbbbbbbbbbbb")
        expect(verify[0]).not.toContain(T.title)
        expect(triaged.report.priorStatus ?? []).toEqual([])
      }),
    120_000,
  )

  // An incremental review whose every new hunk is on a held path has nothing new to send: the files it would send carry
  // nothing new, so it runs no pass rather than a full review of them, and nothing is unreviewed. With a new hunk in a
  // sent file too, the pass runs with that hunk alone in focus. Unset, the held path's hunk is reviewed as before.
  it.instance(
    "an incremental review whose only new hunk is on a held path runs no pass",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const files = [...LIST, ...NETRC]
        const incremental = (focus: { path: string; start: number; end: number }[], holdback?: "secrets") =>
          input(directory, {
            model: priced,
            mode: "incremental",
            since: "3".repeat(40),
            files,
            anchors: files,
            focus,
            config: config(holdback ? { holdback } : {}),
          })
        const heldHunk = { path: "deploy/.netrc", start: 1, end: 1 }
        const outcome = yield* Review.run(incremental([heldHunk], "secrets"))
        expect(yield* modelRequests(llm)).toEqual([])
        expect(outcome.specialists).toEqual([])
        expect(outcome.sessions).toEqual([])
        expect(outcome.unreviewed).toEqual([])
        expect(outcome.skipped).toEqual([{ path: "deploy/.netrc", reason: "held-back" }])
        expect(reviewVerdict({ kind: "outcome", outcome }).verdict).toBe("incomplete")

        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        const mixed = yield* Review.run(incremental([heldHunk, { path: "src/list.ts", start: 1, end: 4 }], "secrets"))
        expect(mixed.specialists.map((entry) => entry.name)).toEqual(["review"])
        const text = lastUserText((yield* llm.hits).find(REVIEW)!.body)
        expect(text).toContain("src/list.ts:1-4")
        expect(text).not.toContain("deploy/.netrc")

        yield* llm.reset
        yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
        const unset = yield* Review.run(incremental([heldHunk]))
        expect(unset.specialists.map((entry) => entry.name)).toEqual(["review"])
        expect(lastUserText((yield* llm.hits).find(REVIEW)!.body)).toContain("deploy/.netrc:1-1")
      }),
    TIMEOUT,
  )
})

// VS-34's tool half (SF-14) at the wire: under "secrets" the review session's rules deny the read tool the credential
// files and every held path, its old path included, and the read and grep tools redact what they return, so a canned
// model that reads and greps held and other files sends no secret in any later request. Unset, the same calls send
// the files as they are. Token-like literals and key headers are assembled at run time.
describe("VS-34 holdback tools (SF-14)", () => {
  const T = {
    envrc: "npm_" + "r7E8".repeat(9),
    config: "ghp_" + "r1U2".repeat(9),
    minified: "sk-proj-" + "m1I2".repeat(8),
  }
  // A value no shape reads: only holding the file back keeps it out.
  const PLAIN = "plain-words-only-pass"
  const [keyBegin, keyEnd] = ["BEGIN", "END"].map((word) => `-----${word} RSA ${"PRIVATE"} KEY-----`)
  const keyBody = Array.from(
    { length: 20 },
    (_, index) => `${"K".repeat(8)}${String(index).padStart(2, "0")}${"r5T6".repeat(13)}z`,
  )
  // A .netrc change, and .envrc renamed to notes.txt: both held, the second by its old path alone.
  const HELD = parseUnifiedDiff(
    [
      "diff --git a/deploy/.netrc b/deploy/.netrc",
      "--- a/deploy/.netrc",
      "+++ b/deploy/.netrc",
      "@@ -1 +1 @@",
      "-machine registry.example.test login old-ci",
      `+machine registry.example.test login ci password ${PLAIN}`,
      "diff --git a/.envrc b/notes.txt",
      "similarity index 90%",
      "rename from .envrc",
      "rename to notes.txt",
      "--- a/.envrc",
      "+++ b/notes.txt",
      "@@ -1 +1 @@",
      `-export DB_PASS=old-${PLAIN}`,
      `+export DB_PASS=${PLAIN}`,
    ].join("\n"),
  )
  const DISK = {
    "deploy/.netrc": `machine registry.example.test login ci password ${PLAIN}\n`,
    "notes.txt": `export DB_PASS=${PLAIN}\n`,
    "config/prod/.envrc": `export TOKEN=${T.envrc}\n`,
    "src/config.ts": `export const token = "${T.config}"\nexport const url = process.env.API_URL\n`,
    "dist/app.min.js": `${"x".repeat(1989)}"${T.minified}"${"y".repeat(50)}\n`,
    "fixtures/key.txt": ["# fixture", keyBegin, ...keyBody, keyEnd].join("\n"),
  }
  const CALLS: [string, Record<string, unknown>][] = [
    ["read", { filePath: "config/prod/.envrc" }],
    ["read", { filePath: "deploy/.netrc" }],
    ["read", { filePath: "notes.txt" }],
    ["read", { filePath: ".envrc" }],
    ["grep", { pattern: "process.env" }],
    ["grep", { pattern: "TOKEN|DB_PASS|password|token|K{8}" }],
    ["grep", { pattern: T.config.slice(0, 8) }],
    ["read", { filePath: "src/config.ts" }],
    ["read", { filePath: "dist/app.min.js" }],
    ["read", { filePath: "fixtures/key.txt", offset: 6, limit: 4 }],
  ]
  const SECRETS = [...Object.values(T), T.minified.slice(0, 10), PLAIN, ...keyBody]

  it.instance(
    "the reviewer's read and grep calls send no secret under secrets, and unset send the files as they are",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const files = yield* FSUtil.Service
        for (const [file, text] of Object.entries(DISK)) yield* files.writeWithDirs(path.join(directory, file), text)
        const sessions = yield* Session.Service
        const runs = yield* Effect.forEach([undefined, "secrets"] as const, (holdback) =>
          Effect.gen(function* () {
            yield* llm.reset
            for (const [tool, args] of CALLS) yield* llm.pushMatch(REVIEW, reply().tool(tool, args))
            yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
            const changed = [...LIST, ...HELD]
            const outcome = yield* Review.run(
              input(directory, {
                model: priced,
                files: changed,
                anchors: changed,
                config: config({ security: "off", maxSteps: 14, ...(holdback ? { holdback } : {}) }),
              }),
            )
            const requests = yield* modelRequests(llm)
            const bodies = requests.map((body) => JSON.stringify(body))
            const rules = yield* sessions
              .get(SessionID.make(outcome.sessions[0]))
              .pipe(Effect.map((session) => session.permission))
            return { outcome, bodies, rules, messages: requests.at(-1)?.messages }
          }),
        )
        const [unset, secrets] = runs
        for (const run of runs) {
          expect(run.outcome.specialists).toEqual([{ name: "review", status: "ok", steps: CALLS.length + 1 }])
          expect(run.bodies).toHaveLength(CALLS.length + 1)
        }
        // Unset, the calls read the files, values and all.
        const sent = unset.bodies.join("\n")
        for (const value of [T.envrc, T.config, PLAIN, keyBody[6], T.minified.slice(0, 10)])
          expect([value, sent.includes(value)]).toEqual([value, true])
        expect(holdsBack(unset.rules)).toBe(false)
        // Secrets: no request after a tool call carries a value, and the tools said why.
        expect(secrets.bodies.flatMap((body) => SECRETS.filter((value) => body.includes(value)))).toEqual([])
        const last = secrets.bodies.at(-1)!
        // The session's rules refuse the credential file, the held files and the renamed file's old path outright.
        for (const file of ["config/prod/.envrc", "deploy/.netrc", "notes.txt", ".envrc"])
          expect(secrets.messages).toContainEqual(
            expect.objectContaining({
              role: "tool",
              content: expect.stringContaining(`A permission rule denies read "${path.normalize(file)}".`),
            }),
          )
        expect(last).toContain("process.env.API_URL")
        expect(last).toContain("[redacted]")
        expect(last).toContain("No files found")
        // The rules hold the session back, held paths and the renamed file's old path among the denies.
        expect(holdsBack(secrets.rules)).toBe(true)
        for (const pattern of ["deploy/.netrc", "notes.txt", ".envrc"])
          expect(secrets.rules).toContainEqual({ permission: "read", pattern, action: "deny" })
        // A trusted review's reviewer may read the saved long outputs, which are redacted by shape alone, so its held
        // note says only what left the prompt (the next test has the untrusted wording).
        expect(secrets.outcome.notes).toContain(noteHeldBack(["deploy/.netrc", "notes.txt"], { promptOnly: true })!)
      }),
    { git: true },
    120_000,
  )

  // The held note says the values were not sent only where the tools hold to it: an untrusted review without --checks,
  // whose reviewer can run no check and read no saved output. Under the local --checks a check command can print any
  // file unredacted, and a trusted review may read back the saved long outputs (Truncate.GLOB), redacted by shape
  // alone, so there it says only what left the review prompt, as SF-13b's did; the rules deny the read tool the held
  // files in all three.
  it.instance(
    "the held note says the values were not sent only in an untrusted review without --checks",
    () =>
      Effect.gen(function* () {
        const { llm, directory } = yield* useServer(PRICE)
        const sessions = yield* Session.Service
        const changed = [...LIST, ...HELD]
        const runs = yield* Effect.forEach(
          [
            { trust: "untrusted" as const },
            { trust: "untrusted" as const, checks: true },
            { trust: "trusted" as const },
          ],
          (overrides) =>
            Effect.gen(function* () {
              yield* llm.pushMatch(REVIEW, reply().tool("StructuredOutput", report()))
              const outcome = yield* Review.run(
                input(directory, {
                  model: priced,
                  files: changed,
                  anchors: changed,
                  ...overrides,
                  config: config({ security: "off", holdback: "secrets" }),
                }),
              )
              const rules = (yield* sessions.get(SessionID.make(outcome.sessions[0]))).permission
              expect(holdsBack(rules)).toBe(true)
              return outcome.notes
            }),
        )
        const [untrusted, checked, trusted] = runs
        const unsent = noteHeldBack(["deploy/.netrc", "notes.txt"])!
        const prompt = noteHeldBack(["deploy/.netrc", "notes.txt"], { promptOnly: true })!
        expect(unsent).toContain("(their values were not sent)")
        expect(prompt).toContain("left them out of the review prompt")
        expect(untrusted).toContain(unsent)
        expect(untrusted).not.toContain(prompt)
        for (const notes of [checked, trusted]) {
          expect(notes).toContain(prompt)
          expect(notes).not.toContain(unsent)
        }
      }),
    { git: true },
    TIMEOUT,
  )
})

// How many findings a review lists, wherever it lists them.
function listedCount(outcome: ReviewOutcome) {
  const selection = outcome.selection
  return [
    ...selection.inline,
    ...selection.overflow,
    ...selection.outsideDiff,
    ...selection.elsewhere,
    ...selection.nits,
  ].length
}
