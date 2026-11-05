import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Fiber, Layer, Stream } from "effect"
import { LLMEvent, Usage } from "@vectordevai/llm"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { FSUtil } from "@vectordevai/core/fs-util"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { parseReviewConfig } from "@vectordevai/core/review/config"
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
} from "@vectordevai/core/review/types"
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
import { SessionID } from "../../src/session/schema"
import { TestInstance, trustWorkspace } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpError, reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"

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

const useServer = (cost?: typeof PRICE) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    const provider = testProviderConfig(llm.url)
    if (cost) provider.provider.lmstudio.models["test-model"].cost = cost
    yield* fs.writeWithDirs(
      path.join(test.directory, "vector.json"),
      JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...provider }),
    )
    yield* fs.writeWithDirs(path.join(test.directory, "src/list.ts"), LIST_SOURCE)
    yield* Effect.promise(() => trustWorkspace(test.directory))
    return { llm, directory: test.directory }
  })

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
