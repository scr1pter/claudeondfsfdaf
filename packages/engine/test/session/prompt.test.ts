import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Database } from "@vectordevai/core/database/database"
import { EventTable } from "@vectordevai/core/event/sql"
import { SessionEvent } from "@vectordevai/schema/session-event"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { LLMEvent } from "@vectordevai/llm"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { afterAll, expect, test } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import { dynamicTool, jsonSchema, type Tool } from "ai"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@vectordevai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { NATIVE_SPECIALISTS } from "@vectordevai/core/agent/specialists"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { McpCloud } from "../../src/mcp/cloud"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@vectordevai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@vectordevai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { InstanceRef } from "../../src/effect/instance-ref"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionExecution } from "@vectordevai/core/session/execution"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "@vectordevai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance, tmpdirScoped, trustWorkspace } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer, type Reply } from "../lib/llm-server"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Auth } from "@/auth"
import { isRecord } from "@/util/record"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { LocationServiceMap, locationServiceMapLayer } from "@vectordevai/core/location-services"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Global } from "@vectordevai/core/global"
import { codiumGateway, codiumModel } from "../../../core/test/fixture/codium-gateway"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("lmstudio"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

type McpFake = {
  instructions?: MCP.ServerInstructions[]
  tools?: () => Record<string, Tool>
  cloudTools?: Record<string, McpCloud.Request>
}

function makeMcp(input: McpFake = {}) {
  return Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      instructions: () => Effect.succeed(input.instructions ?? []),
      // Fresh tools per call: the session overwrites each tool's execute with its permission wrapper.
      tools: () => Effect.sync(() => input.tools?.() ?? {}),
      cloudTools: () => Effect.succeed(input.cloudTools ?? {}),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      resourceTemplates: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      remove: () => Effect.void,
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    }),
  )
}

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

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
    settle: () => Effect.void,
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
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
])

function makePrompt(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp({ instructions: input?.mcpInstructions })],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(promptRoot, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(promptRoot, replacements)
}

function makeHttp(input?: { mcpInstructions?: MCP.ServerInstructions[]; mcp?: McpFake; processor?: "blocking" }) {
  const root = LayerNode.group([promptRoot, testLLMServerNode])
  const replacements = [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp({ instructions: input?.mcpInstructions, ...input?.mcp })],
    [RuntimeFlags.node, runtimeFlags],
  ] as const
  if (input?.processor === "blocking") {
    return LayerNode.compile(root, [...replacements, [SessionProcessor.node, blockingProcessor]])
  }
  return LayerNode.compile(root, replacements)
}

function makeHttpNoLLMServer(input?: { mcpInstructions?: MCP.ServerInstructions[]; processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const closingSnapshot = { entered: defer<void>(), release: defer<void>(), tracks: 0 }
const finishingSnapshots = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [
      Snapshot.node,
      Layer.succeed(
        Snapshot.Service,
        Snapshot.Service.of({
          init: () => Effect.void,
          cleanup: () => Effect.void,
          track: () =>
            Effect.suspend(() => {
              if (++closingSnapshot.tracks === 1) return Effect.succeed("opening")
              closingSnapshot.entered.resolve()
              return Effect.promise(() => closingSnapshot.release.promise).pipe(Effect.as("closing"))
            }),
          patch: () => Effect.succeed({ hash: "opening", files: ["/changed.txt"] }),
          restore: () => Effect.void,
          revert: () => Effect.void,
          diff: () => Effect.succeed(""),
          diffFull: () => Effect.succeed([]),
        }),
      ),
    ],
  ]),
)
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const freePrompts = testEffect(
  LayerNode.compile(promptRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([FREE_MODEL_FALLBACKS[0]]),
        trainingConsent: () => Effect.succeed(false),
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
        stream: (input) =>
          Stream.make(
            LLMEvent.textStart({ id: "model" }),
            LLMEvent.textDelta({ id: "model", text: `${input.model.providerID}/${input.model.id}` }),
            LLMEvent.textEnd({ id: "model" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ),
      }),
    ],
  ]),
)
// The user's own OpenRouter account lists a no-training model and one whose provider may train, and the owner has
// accepted the training notice.
const lagunaFree = {
  id: "poolside/laguna-s-2.1:free",
  name: "Poolside: Laguna S 2.1",
  contextLength: 262144,
  maxOutputTokens: 32768,
  providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
}
const trainingPrompts = testEffect(
  LayerNode.compile(promptRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([FREE_MODEL_FALLBACKS[0], lagunaFree]),
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
  ]),
)
// Vector Codium through the real provider path, against a local stand-in for the vectordev.ai gateway.
const codiumToken = "vct_synthetic-private-account.token"
const codiumAccount = { token: codiumToken as string | undefined }
const gateway = codiumGateway(codiumToken)
afterAll(() => gateway.stop())
const codiumPrompts = testEffect(
  LayerNode.compile(promptRoot, [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, runtimeFlags],
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([]),
        trainingConsent: () => Effect.succeed(false),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
    ],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "vector" ? codiumAccount.token : undefined),
      }),
    ],
    [
      ModelPlans.node,
      Layer.succeed(ModelPlans.Service, {
        catalog: (token) =>
          Effect.succeed(
            token === codiumToken ? { enabled: true, models: [codiumModel] } : { enabled: false, models: [] },
          ),
        request: gateway.forward,
      }),
    ],
  ]),
)
const codiumRef = { providerID: ProviderV2.ID.make(ModelPlans.PROVIDER_ID), modelID: ModelV2.ID.make(codiumModel.id) }

const withMcpInstructions = testEffect(
  makeHttp({
    mcpInstructions: [
      {
        name: "guide-server",
        instructions: "Use lookup before mutate.",
        tools: ["guide-server_lookup"],
      },
    ],
  }),
)
// A Supabase MCP server's execute_sql, as the catalog's server lists it.
const supabaseSqlRuns: unknown[] = []
const withSupabaseMcp = testEffect(
  makeHttp({
    mcp: {
      tools: () => ({
        supabase_execute_sql: dynamicTool({
          description: "Run SQL on the linked Supabase project",
          inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
          execute: async (args) => {
            supabaseSqlRuns.push(args)
            return { content: [{ type: "text", text: "[]" }] }
          },
        }),
      }),
      cloudTools: {
        supabase_execute_sql: {
          permission: "vector_cloud_database",
          provider: "Supabase",
          server: "supabase",
          tool: "execute_sql",
        },
      },
    },
  }),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom model under the supported lmstudio provider
// so provider model lookup succeeds inside the loop.
const cfg = {
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
        // The fake server answers any number of requests at once, unlike a model server whose count nobody set.
        concurrency: 64,
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      lmstudio: {
        ...cfg.provider.lmstudio,
        options: {
          ...cfg.provider.lmstudio.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "vector.json"),
    JSON.stringify({ $schema: "https://vectordev.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const file = path.join(dir, "vector.json")
  yield* writeConfig(dir, config(llm.url))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [file]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  return { dir, llm }
})

// Run limits come only from the user's own config: a repository's budget.run is ignored, trusted or not. The process
// environment is the user-level source an instance reads when its config loads.
const useUserConfig = Effect.fn("test.useUserConfig")(function* (config: Partial<ConfigV1.Info>) {
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.VECTOR_CONFIG_CONTENT
      process.env.VECTOR_CONFIG_CONTENT = JSON.stringify(config)
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.VECTOR_CONFIG_CONTENT
        else process.env.VECTOR_CONFIG_CONTENT = previous
      }),
  )
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const heldShell = Effect.fn("test.heldShell")(function* (sessionID: SessionID) {
  const instance = yield* TestInstance
  const prompt = yield* SessionPrompt.Service
  const fs = yield* FSUtil.Service
  const shell = Shell.preferred()
  const executable = process.execPath.replaceAll("\\", "/")
  const command = Shell.ps(shell)
    ? `[IO.File]::WriteAllText('.shell-started', 'started'); & '${executable.replaceAll("'", "''")}' ./held-shell.ts`
    : Shell.name(shell) === "cmd"
      ? `echo started> .shell-started & "${executable}" ./held-shell.ts`
      : `: > .shell-started; '${executable.replaceAll("'", "'\\''")}' ./held-shell.ts`
  const phase = (name: string) =>
    Effect.sync(() => {
      if (process.platform === "win32") console.error(JSON.stringify({ fixture: "held-shell", phase: name, shell }))
    })
  yield* writeText(
    path.join(instance.directory, "held-shell.ts"),
    `await Bun.write(".shell-ready", "ready")
while (!(await Bun.file(".shell-release").exists())) await Bun.sleep(10)
console.log("shell-released")
`,
  )
  yield* phase("starting-child")
  const fiber = yield* prompt
    .shell({
      sessionID,
      agent: "build",
      command,
    })
    .pipe(Effect.forkChild)
  yield* pollWithTimeout(
    Effect.gen(function* () {
      if (yield* fs.existsSafe(path.join(instance.directory, ".shell-ready"))) return true
      if (fiber.pollUnsafe()) return yield* Effect.fail(new Error("shell completed before publishing child readiness"))
    }),
    `shell child did not publish readiness (${shell})`,
    // On Windows the shell is PowerShell or cmd starting a Bun process, which can take longer than the default
    // 5 seconds on a busy runner before the child writes .shell-ready.
    "20 seconds",
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const exit = fiber.pollUnsafe()
        const messages = yield* MessageV2.filterCompactedEffect(sessionID)
        const part = messages.flatMap((message) => message.parts).findLast((part) => part.type === "tool")
        return yield* Effect.fail(
          new Error(
            JSON.stringify({
              phase: "child-readiness-failed",
              shell,
              command,
              shellStarted: yield* fs.existsSafe(path.join(instance.directory, ".shell-started")),
              fiber: exit ? (Exit.isSuccess(exit) ? "success" : "failure") : "pending",
              fiberError: exit && Exit.isFailure(exit) ? Cause.pretty(exit.cause).slice(0, 2048) : undefined,
              toolState: part ? JSON.stringify(part.state).slice(0, 2048) : undefined,
              error: Cause.pretty(cause).slice(0, 2048),
            }),
          ),
        )
      }),
    ),
  )
  yield* phase("child-ready")
  return {
    fiber,
    phase,
    release: phase("releasing-child").pipe(
      Effect.andThen(writeText(path.join(instance.directory, ".shell-release"), "release")),
    ),
  }
})

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (
  sessionID: SessionID,
  text: string,
  agent = "build",
  // The sender's size; tests of the full build harness pin Thorough so a generic prompt is not sized down.
  size?: SessionV1.User["size"],
) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent,
    model: ref,
    time: { created: Date.now() },
    ...(size ? { size } : {}),
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { trusted: true, config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("stopping a session answers the permission request its tool is waiting on", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const waiting = yield* permission
      .ask({
        sessionID: chat.id,
        permission: "webfetch",
        patterns: ["https://example.com"],
        metadata: {},
        always: ["*"],
        ruleset: [],
      })
      .pipe(Effect.exit, Effect.forkChild)
    yield* pollWithTimeout(
      Effect.map(permission.list(), (list) => (list.length > 0 ? true : undefined)),
      "the request was never asked",
      "2 seconds",
    )

    yield* prompt.cancel(chat.id)

    expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true)
    expect(yield* permission.list()).toHaveLength(0)
  }),
)

it.instance("an autocomplete request carries only the current request, its own prompt and no tools", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Autocomplete", agent: "autocomplete" })
    yield* llm.text("first()")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "autocomplete",
      model: ref,
      parts: [{ type: "text", text: "complete one" }],
    })
    yield* llm.text("second()")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "autocomplete",
      model: ref,
      parts: [{ type: "text", text: "complete two" }],
    })
    const body = JSON.stringify((yield* llm.hits).at(-1)?.body)
    expect(body).toContain("complete two")
    expect(body).not.toContain("complete one")
    expect(body).toContain("Vector Tab")
    expect((yield* llm.hits).at(-1)?.body.tools).toBeUndefined()
  }),
)

it.instance("title generation sends only what the user typed", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
    yield* llm.text("done")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [
        { type: "text", text: "Fix the login redirect" },
        { type: "text", text: "ATTACHED FILE CONTENTS", synthetic: true },
      ],
    })
    const title = yield* pollWithTimeout(
      Effect.map(llm.hits, (hits) =>
        hits.map((hit) => JSON.stringify(hit.body)).find((body) => body.includes("Generate a title")),
      ),
      "timed out waiting for the title request",
      "10 seconds",
    )
    expect(title).toContain("Fix the login redirect")
    expect(title).not.toContain("ATTACHED FILE CONTENTS")
    yield* prompt.awaitTitles()
    const database = yield* Database.Service
    const recorded = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, chat.id)).all()
    const usage = recorded.filter((event) => event.type === `${SessionEvent.AncillaryUsage.type}.2`)
    expect(usage).toHaveLength(1)
    // The server's automatic title reply reports no usage; keep its spend unknown rather than inventing tokens.
    expect(usage[0]?.data).toMatchObject({ incomplete: true, unpriced: true })
    expect(usage[0]?.data.tokens).toBeUndefined()
    const history = yield* sessions.messages({ sessionID: chat.id })
    expect(history.filter((message) => message.info.role === "assistant")).toHaveLength(1)
    // The title request goes out only after the main request, and the model's title replaces the provisional one.
    const bodies = (yield* llm.hits).map((hit) => JSON.stringify(hit.body))
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).not.toContain("Generate a title")
    expect(bodies[1]).toContain("Generate a title")
    expect((yield* sessions.get(chat.id)).title).toBe("E2E Title")
  }),
)

it.instance("a client-named session answers without a separate title request", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Fix the login redirect",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* llm.text("done")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [
        { type: "text", text: "Fix the login redirect\nafter the session expires" },
        { type: "text", text: "ATTACHED FILE CONTENTS", synthetic: true },
      ],
    })
    yield* prompt.awaitTitles()
    expect((yield* sessions.get(chat.id)).title).toBe("Fix the login redirect")
    const bodies = (yield* llm.hits).map((hit) => JSON.stringify(hit.body))
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toContain("Generate a title")
    const database = yield* Database.Service
    const recorded = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, chat.id)).all()
    expect(recorded.filter((event) => event.type === `${SessionEvent.AncillaryUsage.type}.2`)).toEqual([])
  }),
)

it.instance("a title on a model server on this computer is brief, and one cut off while thinking is not used", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
    // A model that thinks aloud reaches its reply limit before it closes its thinking.
    yield* llm.title("<think>The user wants a short title about the login redirect, so")
    yield* llm.text("done")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      parts: [{ type: "text", text: "Fix the login redirect" }],
    })
    yield* prompt.awaitTitles()
    const title = (yield* llm.hits).find((hit) => JSON.stringify(hit.body).includes("Generate a title"))
    // The fake server is on this computer, so the title's reply is held to a few hundred tokens.
    expect(title?.body.max_tokens).toBe(ProviderSvc.BRIEF_REPLY)
    expect((yield* sessions.get(chat.id)).title).toBe("Fix the login redirect")
    yield* llm.title("E2E Title")
  }),
)

codiumPrompts.instance("a Codium session's title goes through the gateway and counts its tokens, not dollars", () =>
  Effect.gen(function* () {
    gateway.state.mode = "text"
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
    const before = gateway.seen.length
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: codiumRef,
      parts: [{ type: "text", text: "Fix the login redirect" }],
    })
    yield* prompt.awaitTitles()
    gateway.state.mode = "ok"
    const sent = gateway.seen.slice(before)
    const title = sent.find((item) => JSON.stringify(item.body).includes("Generate a title"))
    expect(title).toMatchObject({ path: "/api/model-plans/chat", authorization: `Bearer ${codiumToken}` })
    expect(title?.body).toMatchObject({ model: codiumModel.id })
    expect(sent.every((item) => item.path === "/api/model-plans/chat")).toBe(true)
    expect((yield* sessions.get(chat.id)).title).toBe("Fix the login redirect")
    const database = yield* Database.Service
    const recorded = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, chat.id)).all()
    const usage = recorded.filter((event) => event.type === `${SessionEvent.AncillaryUsage.type}.2`)
    expect(usage).toHaveLength(1)
    // Title spend counts toward the session in tokens; credits are a share of the plan, never dollars to add up.
    expect(usage[0]?.data).toMatchObject({
      purpose: "title",
      model: { providerID: ModelPlans.PROVIDER_ID, id: codiumModel.id },
      cost: 0,
      unpriced: true,
    })
    expect(usage[0]?.data.tokens).toMatchObject({ input: 200, output: 6 })
  }),
)

codiumPrompts.instance("a Codium subagent's steps count once, in tokens, and add no dollars", () =>
  Effect.gen(function* () {
    gateway.state.mode = "text"
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const asked = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: codiumRef,
      noReply: true,
      parts: [{ type: "text", text: "Find where the cache key is built" }],
    })
    yield* addSubtask(chat.id, asked.info.id, codiumRef)
    const before = gateway.seen.length
    yield* prompt.loop({ sessionID: chat.id })
    gateway.state.mode = "ok"
    const sent = gateway.seen.slice(before)
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.every((item) => item.path === "/api/model-plans/chat")).toBe(true)
    const [child] = yield* sessions.children(chat.id)
    if (!child) throw new Error("Expected the subagent's session")
    const parent = yield* sessions.get(chat.id)
    const spent = yield* sessions.get(child.id)
    // Codium steps spend credits, which Settings shows as a share of the plan; dollar totals leave them out and say
    // so, and each step is counted once: the subagent's in its session and in its parent's delegated spend.
    expect(spent.cost).toBe(0)
    expect(spent.unpricedSteps).toBeGreaterThan(0)
    expect(parent.subagentUnpricedSteps).toBe(spent.unpricedSteps)
    expect((parent.cost ?? 0) + (parent.subagentCost ?? 0)).toBe(0)
    expect((parent.unpricedSteps ?? 0) + (parent.subagentUnpricedSteps ?? 0)).toBe(sent.length)
  }),
)

codiumPrompts.instance("a Codium turn after signing out reports why and offers Sign in to Vector", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: codiumRef,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const before = gateway.seen.length
    codiumAccount.token = undefined
    const result = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.exit)
    codiumAccount.token = codiumToken
    yield* off
    expect(Exit.isFailure(result)).toBe(true)
    expect(gateway.seen.length).toBe(before)
    expect(errors.map((error) => ModelPlanStatus.failureAction(error))).toEqual(["sign-in"])
    expect(errors[0]?.data).toMatchObject({
      message: expect.stringContaining("Sign in to Vector to use Vector Codium"),
    })
  }),
)
it.instance(
  "a session is titled from the prompt at once, and a title set before the model's arrives stays",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "allow" }] })
      // Nothing of the reply reaches Vector until the test releases it, so the provider is not yet answering.
      const answer = defer<void>()
      const held = reply().wait(answer.promise).text("done").stop().item()
      if (held.type !== "sse") throw new Error("expected a streamed reply")
      yield* llm.push({ ...held, head: [], tail: [...held.head, ...held.tail] })

      const run = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "  Fix the login   redirect\nafter the session expires" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.map(sessions.get(chat.id), (session) =>
          session.title === "Fix the login redirect" ? (true as const) : undefined,
        ),
        "the session never got its provisional title",
        "10 seconds",
      )
      // The title request waits for the main request to be answered.
      expect(yield* llm.hits).toHaveLength(1)

      yield* sessions.setTitle({ sessionID: chat.id, title: "Login redirect" })
      answer.resolve()
      yield* Fiber.join(run)
      yield* prompt.awaitTitles()

      expect((yield* sessions.get(chat.id)).title).toBe("Login redirect")
      expect(
        (yield* llm.hits).map((hit) => JSON.stringify(hit.body)).filter((body) => body.includes("Generate a title")),
      ).toEqual([])
    }),
  30_000,
)

for (const ending of ["cancel", "reject"] as const)
  it.instance(
    `a first request that ends before answering keeps its provisional title (${ending})`,
    () =>
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({})
        if (ending === "cancel") {
          const held = reply().hang().item()
          if (held.type !== "sse") throw new Error("expected a streamed reply")
          yield* llm.push({ ...held, head: [] })
        }
        if (ending === "reject") yield* llm.error(400, { error: { message: "request rejected" } })
        const run = yield* prompt
          .prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "Fix login" }] })
          .pipe(Effect.forkChild)
        yield* llm.wait(1)
        if (ending === "cancel") yield* prompt.cancel(chat.id)
        yield* Fiber.join(run)
        yield* prompt.awaitTitles()
        expect((yield* sessions.get(chat.id)).title).toBe("Fix login")
        expect(yield* llm.hits).toHaveLength(1)
        const database = yield* Database.Service
        const recorded = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, chat.id)).all()
        expect(recorded.filter((event) => event.type === `${SessionEvent.AncillaryUsage.type}.2`)).toEqual([])
      }),
    30_000,
  )

it.instance("a session reads its instruction files once, so an edit mid-session keeps the cached system prompt", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const instance = yield* InstanceRef
    if (!instance) return yield* Effect.die("no instance")
    const rules = path.join(instance.directory, "AGENTS.md")
    yield* Effect.promise(() => Bun.write(rules, "# First rules"))
    const turn = (sessionID: SessionID, text: string) =>
      Effect.gen(function* () {
        yield* prompt.prompt({ sessionID, agent: "build", noReply: true, parts: [{ type: "text", text }] })
        yield* llm.text("ok")
        yield* prompt.loop({ sessionID })
      })

    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* turn(chat.id, "inspect the repository")
    // Like the agent updating .vector/BRAIN.md: the file changes between requests of one session.
    yield* Effect.promise(() => Bun.write(rules, "# Second rules"))
    yield* turn(chat.id, "inspect it again")
    const fresh = yield* sessions.create({
      title: "Fresh",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* turn(fresh.id, "inspect the repository")

    const bodies = (yield* llm.hits).map((hit) => JSON.stringify(hit.body))
    expect(bodies).toHaveLength(3)
    expect(bodies[1]).toContain("# First rules")
    expect(bodies[1]).not.toContain("# Second rules")
    // A new session reads the files as they are now.
    expect(bodies[2]).toContain("# Second rules")
  }),
)

withMcpInstructions.instance(
  "loop includes MCP instructions in model system context",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.hang
      yield* user(chat.id, "inspect the repository")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for MCP instruction request", "10 seconds")

      const hits = yield* llm.hits
      const body = JSON.stringify(hits[0]?.body)
      expect(body).toContain('<server name=\\"guide-server\\">')
      expect(body).toContain("Use lookup before mutate.")
      yield* Fiber.interrupt(fiber)
    }),
  15_000,
)

withSupabaseMcp.instance(
  "a Supabase MCP server's SQL asks under vector_cloud_database even when every tool is allowed",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Supabase MCP",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* user(chat.id, "count the users")
      yield* llm.tool("supabase_execute_sql", { query: "select count(*) from auth.users" })
      yield* llm.text("done")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* permission.list()).find((item) => item.permission === "vector_cloud_database")
        }),
        "the Supabase MCP tool did not ask under vector_cloud_database",
        "15 seconds",
      )
      expect(request).toMatchObject({
        patterns: ["supabase/mcp/supabase/execute_sql"],
        always: [],
        metadata: { provider: "Supabase", action: "execute_sql" },
      })
      expect(JSON.stringify(request.metadata.statements)).toContain("select count(*) from auth.users")
      yield* permission.reply({ requestID: request.id, reply: "reject" })
      yield* Fiber.await(fiber)
      expect(supabaseSqlRuns).toEqual([])
    }),
  30_000,
)

// Runs one turn as `agent` and returns the first model request body, which carries the system prompt.
const firstRequestBody = Effect.fn("test.firstRequestBody")(function* (input: {
  agent?: string
  config?: Partial<ConfigV1.Info>
  /** Run the turn in a child session whose own rules still allow the task tool. */
  nested?: boolean
}) {
  const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), ...input.config }))
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const parent = input.nested ? yield* sessions.create({ title: "Parent" }) : undefined
  const chat = yield* sessions.create({
    title: "Pinned",
    ...(parent
      ? { parentID: parent.id, permission: [{ permission: "task", pattern: "*", action: "allow" as const }] }
      : {}),
  })
  yield* llm.hang
  yield* user(chat.id, "hello", input.agent, "thorough")

  const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
  yield* awaitWithTimeout(llm.wait(1), "timed out waiting for the first model request", "10 seconds")
  const body = JSON.stringify((yield* llm.hits)[0]?.body)
  yield* Fiber.interrupt(fiber)
  return body
})

it.instance(
  "loop puts the stable system prompt ahead of the directory and date, as its own block where the provider caches by breakpoint",
  () =>
    Effect.gen(function* () {
      const claude = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("claude-test") }
      const { llm } = yield* useServerConfig((url) => {
        const base = providerCfg(url)
        return {
          ...base,
          provider: {
            ...base.provider,
            lmstudio: {
              ...base.provider.lmstudio,
              models: {
                ...base.provider.lmstudio.models,
                "claude-test": {
                  ...base.provider.lmstudio.models["test-model"],
                  id: "claude-test",
                  name: "Claude Test",
                },
              },
            },
          },
        }
      })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const system = (body: unknown) =>
        (body as { messages: { role: string; content: unknown }[] }).messages
          .filter((message) => message.role === "system")
          .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      const run = (model: typeof claude) =>
        Effect.gen(function* () {
          const chat = yield* sessions.create({ title: "Pinned" })
          yield* llm.text("ok")
          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            model,
            size: "thorough",
            parts: [{ type: "text", text: "hello" }],
          })
        })

      yield* run(ref)
      yield* run(claude)
      const [plain, cached] = (yield* llm.hits).map((hit) => system(hit.body))

      // A provider that caches prefixes on its own gets one block, with the stable parts first.
      expect(plain).toHaveLength(1)
      expect(plain[0].indexOf("<subagent_policy>")).toBeLessThan(plain[0].indexOf("Working directory"))
      // A provider that caches by breakpoint gets the stable parts as a block of their own, so it is reused across
      // sessions, directories and days.
      expect(cached).toHaveLength(2)
      expect(cached[0]).toContain("You are Vector")
      expect(cached[0]).toContain("<subagent_policy>")
      expect(cached[0]).not.toContain("Working directory")
      expect(cached[0]).not.toContain("Today's date")
      expect(cached[1]).toContain("Working directory")
    }),
  30_000,
)

it.instance(
  "loop tells the model to do the work itself and delegate only what is cheaper split up",
  () =>
    Effect.gen(function* () {
      const body = yield* firstRequestBody({})
      expect(body).toContain("Do the work yourself by default, multi-file changes included")
      expect(body).toContain("Launch a general Subagent (omit subagent_type) only when that costs less")
      expect(body).toContain("small fixes, single-file changes and lookups you do yourself")
      expect(body).toContain("Delegated batches run in the background by default")
      expect(body).toContain("Use task_manage")
      expect(body).toContain("never poll")
      expect(body).not.toContain("MUST launch general Subagents")
      expect(body).not.toContain("General Subagents are turned off")
      expect(body).not.toContain("You are a Subagent working on a brief")
      // No team is configured here, so neither the teammate tool nor its guidance is sent.
      expect(body).not.toContain("send_teammate_message")
      // The browser and cloud tools are not offered outside the desktop, so their policies are left out too.
      expect(body).not.toContain("<browser_engineering_policy>")
      expect(body).not.toContain("<vector_cloud_policy>")
      expect(body).toContain("<completion_policy>")
    }),
  15_000,
)

it.instance(
  "an agent that may not use the browser tool gets no browser policy, even where the tool exists",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        process.env.VECTOR_BROWSER_BRIDGE_URL = "http://127.0.0.1:1"
        process.env.VECTOR_BROWSER_BRIDGE_TOKEN = "test"
      }),
      () =>
        Effect.gen(function* () {
          // explore denies every tool but its read-only set, browser included.
          const body = yield* firstRequestBody({ agent: "explore" })
          expect(body).not.toContain("<browser_engineering_policy>")
          // Nor the implementation-loop and process rules of an agent that can change the project.
          expect(body).not.toContain("<completion_policy>")
          expect(body).not.toContain("<process_safety_policy>")
        }),
      () =>
        Effect.sync(() => {
          delete process.env.VECTOR_BROWSER_BRIDGE_URL
          delete process.env.VECTOR_BROWSER_BRIDGE_TOKEN
        }),
    ),
  15_000,
)

it.instance(
  "loop tells the model general Subagents are off when config disables general",
  () =>
    Effect.gen(function* () {
      const body = yield* firstRequestBody({ config: { agent: { general: { disable: true } } } })
      expect(body).toContain("General Subagents are turned off in Vector settings (agent.general.disable).")
      expect(body).toContain("explore for read-only discovery")
      expect(body).not.toContain("the default when you omit subagent_type")
      // task.txt, also in the body, gives the big-task rule only "when general is in the list".
      expect(body).not.toContain("MUST launch general Subagents with the task tool (omit subagent_type)")
    }),
  15_000,
)

it.instance(
  "loop suggests explore for a search that spans several areas while explore is on",
  () =>
    Effect.gen(function* () {
      const body = yield* firstRequestBody({})
      expect(body).toContain('prefer it with subagent_type \\"explore\\"')
    }),
  15_000,
)

// With explore turned off a prompt that still suggested it would send the model's first task call to a missing agent.
it.instance(
  "loop points a search at the task tool's list when config turns explore off",
  () =>
    Effect.gen(function* () {
      const body = yield* firstRequestBody({ config: { agent: { explore: { disable: true } } } })
      expect(body).not.toContain('subagent_type \\"explore\\"')
      expect(body).toContain("prefer it with a search specialist from the task tool's list")
      expect(body).not.toContain("explore for read-only discovery")
    }),
  15_000,
)

it.instance(
  "loop's plan reminder names no explore agents when config turns explore off",
  () =>
    Effect.gen(function* () {
      const body = yield* firstRequestBody({ agent: "plan", config: { agent: { explore: { disable: true } } } })
      expect(body).not.toContain("delegate explore agents")
      expect(body).toContain("delegate to specialists from the task tool's list")
      expect(body).not.toContain('subagent_type \\"explore\\"')
    }),
  15_000,
)

it.instance(
  "loop tells Plan mode that its agent cannot launch general Subagents, and names only its specialists",
  () =>
    Effect.gen(function* () {
      const body = yield* firstRequestBody({ agent: "plan" })
      expect(body).toContain("The plan agent cannot launch general Subagents in this session.")
      expect(body).toContain("explore for read-only discovery; review for code review; security for security analysis.")
      expect(body).not.toContain("debug for reproducing and repairing failures")
      expect(body).not.toContain("Vector settings (agent.general.disable)")
      expect(body).not.toContain("the default when you omit subagent_type")
      // task.txt, also in the body, gives the big-task rule only "when general is in the list".
      expect(body).not.toContain("MUST launch general Subagents with the task tool (omit subagent_type)")
    }),
  15_000,
)

it.instance(
  "loop tells a subagent's own session not to launch general Subagents",
  () =>
    Effect.gen(function* () {
      const body = yield* firstRequestBody({ agent: "general", nested: true })
      expect(body).toContain("You are a Subagent working on a brief from a parent agent")
      expect(body).not.toContain("the default when you omit subagent_type")
      // task.txt, also in the body, gives the big-task rule only "when general is in the list".
      expect(body).not.toContain("MUST launch general Subagents with the task tool (omit subagent_type)")
    }),
  15_000,
)

it.instance("legacy prompt emits message events without session.next events", () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      agent: "plan",
      model: { providerID: ProviderV2.ID.make("old"), id: ModelV2.ID.make("old-model") },
    })
    const seen: string[] = []
    const off = yield* events.listen((event) => {
      seen.push(event.type)
      return Effect.void
    })

    const first = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    const second = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "again" }],
    })
    yield* off

    expect(first.info.role).toBe("user")
    expect(second.info.role).toBe("user")
    if (first.info.role === "user" && second.info.role === "user") {
      expect(first.info.model).toEqual(ref)
      expect(second.info.model).toEqual(ref)
    }
    expect(yield* sessions.get(chat.id)).toMatchObject({
      agent: "build",
      model: { providerID: ref.providerID, id: ref.modelID },
    })
    expect(seen).toContain(Session.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.Updated.type)
    expect(seen).toContain(MessageV2.Event.PartUpdated.type)
    expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
  }),
)

it.instance("a session saved with a retired provider's model continues with the default model", () =>
  Effect.gen(function* () {
    yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const provider = yield* ProviderSvc.Service
    const chat = yield* sessions.create({
      title: "From an earlier version",
      model: { providerID: ProviderV2.ID.make("retired-gateway"), id: ModelV2.ID.make("included-model") },
    })

    const next = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "continue" }],
    })

    const fallback = yield* provider.defaultModel()
    expect(next.info.role).toBe("user")
    if (next.info.role === "user") {
      expect(next.info.model.providerID).toBe(fallback.providerID)
      expect(next.info.model.modelID).toBe(fallback.modelID)
    }
  }),
)

it.instance("an earlier message on a retired provider's model does not choose the next prompt's model", () =>
  Effect.gen(function* () {
    yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const provider = yield* ProviderSvc.Service
    const chat = yield* sessions.create({ title: "From an earlier version" })
    yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("retired-gateway"), modelID: ModelV2.ID.make("included-model") },
      time: { created: Date.now() },
    })

    const next = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "continue" }],
    })

    const fallback = yield* provider.defaultModel()
    expect(next.info.role).toBe("user")
    if (next.info.role === "user") {
      expect(next.info.model.providerID).toBe(fallback.providerID)
      expect(next.info.model.modelID).toBe(fallback.modelID)
    }
  }),
)

it.instance("a session saved under a renamed provider continues on the provider it was renamed to", () =>
  Effect.gen(function* () {
    yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "From 1.99.8",
      model: { providerID: ProviderV2.ID.make("kimi-for-coding"), id: ModelV2.ID.make("k3") },
    })

    const next = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "continue" }],
    })

    expect(next.info.role).toBe("user")
    if (next.info.role === "user") {
      expect(String(next.info.model.providerID)).toBe("kimi-code-plan-cn")
      expect(String(next.info.model.modelID)).toBe("k3")
    }
  }),
)

it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const events = yield* EventV2Bridge.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const off = yield* events.listen((event) => {
      if (event.type !== Session.Event.Error.type) return Effect.void
      const data = event.data as typeof Session.Event.Error.data.Type
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
      return Effect.void
    })

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    yield* off

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(
          LayerNode.compile(SessionV2.node, [
            [SessionExecution.node, SessionExecution.noopLayer],
            [LocationServiceMap.node, locationServiceMapLayer],
          ]),
        ),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { trusted: true, config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("loop continues after a missing-file read with a valid read and final response", () =>
  Effect.gen(function* () {
    const setup = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Read recovery",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const missing = path.join(setup.dir, "does-not-exist.txt")
    const valid = path.join(setup.dir, "available.txt")
    yield* writeText(valid, "native read recovery content\n")
    expect(yield* Effect.promise(() => Bun.file(missing).exists())).toBe(false)

    yield* setup.llm.tool("read", { filePath: missing })
    yield* setup.llm.tool("read", { filePath: valid })
    yield* setup.llm.text("Recovered from the missing file.")
    const result = yield* prompt.prompt({
      sessionID: session.id,
      model: ref,
      agent: "build",
      parts: [{ type: "text", text: "Read the requested file and recover if it is missing." }],
    })

    const reads = (yield* MessageV2.filterCompactedEffect(session.id))
      .flatMap((message) => message.parts)
      .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "read")
    expect(reads).toHaveLength(2)
    expect(reads[0]).toMatchObject({
      state: {
        status: "error",
        input: { filePath: missing },
        error: expect.stringContaining(`File not found: ${missing}`),
      },
    })
    expect(reads[1]).toMatchObject({
      state: {
        status: "completed",
        input: { filePath: valid },
        output: expect.stringContaining("native read recovery content"),
      },
    })
    const inputs = yield* setup.llm.inputs
    expect(inputs).toHaveLength(3)
    expect(inputs[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: reads[0].callID,
          content: expect.stringContaining(`File not found: ${missing}`),
        }),
      ]),
    )
    expect(inputs[2].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: reads[1].callID,
          content: expect.stringContaining("native read recovery content"),
        }),
      ]),
    )
    expect(result.info).toMatchObject({ role: "assistant", finish: "stop" })
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "Recovered from the missing file." })]),
    )
    expect(yield* setup.llm.pending).toBe(0)
    expect(yield* setup.llm.misses).toEqual([])
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    // Glob lists paths relative to the session's directory, so the bare name shows it searched there.
    expect(tool.state.output).toContain(path.relative(dir, file))
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

// Vector lets the model send an edit and the check that verifies it in one response. The check must still run, and run
// on the edited file, whichever order the model wrote the two calls in.
for (const order of [
  ["edit", "bash"],
  ["bash", "edit"],
] as const)
  unix(
    `an edit and its check in one response: the check runs after the edit (${order.join(", ")})`,
    () =>
      Effect.gen(function* () {
        const { llm, dir } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const file = path.join(dir, "value.txt")
        yield* writeText(file, "before\n")
        const session = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const calls = {
          edit: { filePath: file, oldString: "before", newString: "after" },
          bash: { command: "cat value.txt", description: "Show the value" },
        }
        yield* llm.push(reply().tool(order[0], calls[order[0]]).tool(order[1], calls[order[1]]))
        yield* llm.text("done")

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "Change the value to after and check it" }],
        })

        const parts = (yield* MessageV2.filterCompactedEffect(session.id)).flatMap((msg) => msg.parts)
        const completed = (name: string) =>
          parts.find(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.tool === name && part.state.status === "completed",
          )
        expect(completed("edit")).toBeDefined()
        expect(completed("bash")?.state.output).toContain("after")
        expect(completed("bash")?.state.output).not.toContain("before")
        // One response for the edit and its check, one for the reply.
        expect(yield* llm.hits).toHaveLength(2)
      }),
    30_000,
  )

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "lmstudio/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("lmstudio"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      model: ref,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      model: ref,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        background: false,
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello", "build", "thorough")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance("loop sets status to busy then idle", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service

    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    expect((yield* status.get(chat.id)).type).toBe("busy")
    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
    expect((yield* status.get(chat.id)).type).toBe("idle")
  }),
)

// Cancel semantics

finishingSnapshots.instance(
  "cancel waits for a completed step's closing snapshot and patch",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.text("done")
      const run = yield* prompt
        .prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "hello" }] })
        .pipe(Effect.forkChild)
      yield* Effect.promise(() => closingSnapshot.entered.promise)
      const stopping = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
      // Let cancellation reach the run while its closing snapshot is held.
      yield* Effect.sleep("20 millis")
      expect(stopping.pollUnsafe()).toBeUndefined()
      closingSnapshot.release.resolve()
      yield* Fiber.join(stopping)
      yield* Fiber.join(run)
      const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
      expect(parts.find((part) => part.type === "step-finish")).toMatchObject({ snapshot: "closing" })
      expect(parts.find((part) => part.type === "patch")).toMatchObject({ hash: "opening", files: ["/changed.txt"] })
    }).pipe(Effect.ensuring(Effect.sync(() => closingSnapshot.release.resolve()))),
  30_000,
)

it.instance("cancel interrupts loop and resolves with an assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* seed(chat.id)

    yield* llm.hang

    yield* user(chat.id, "more")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
    }
  }),
)

it.instance("cancel records MessageAbortedError on interrupted process", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hello")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)
    yield* prompt.cancel(chat.id)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const info = exit.value.info
      if (info.role === "assistant") {
        expect(info.error?.name).toBe("MessageAbortedError")
      }
    }
  }),
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { trusted: true, config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { trusted: true, config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance("concurrent loop callers all receive same error result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.fail("boom")
    yield* user(chat.id, "hello")

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })
    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
  }),
)

it.instance("prompt submitted during an active run is included in the next LLM input", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.hold("first", deferredAsPromise(gate))
    yield* llm.text("second")

    const a = yield* prompt
      .prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "first" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)

    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )

    yield* Deferred.succeed(gate, void 0)

    const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
    expect(Exit.isSuccess(ea)).toBe(true)
    expect(Exit.isSuccess(eb)).toBe(true)
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* sessions.messages({ sessionID: chat.id })
    const assistants = msgs.filter((msg) => msg.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    const last = assistants.at(-1)
    if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
    expect(last.info.parentID).toBe(id)
    expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    const messages = inputs.at(-1)?.messages
    if (!Array.isArray(messages)) throw new Error("expected LLM messages")
    // The joined prompt is the newest message; the request's size guidance rides along with it.
    expect(messages.at(-1)).toMatchObject({ role: "user" })
    expect(JSON.stringify(messages.at(-1))).toContain("second")
  }),
)

it.instance("a prompt that joins a run which then stops without reading it is still answered", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const gate = yield* Deferred.make<void>()
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    // The first turn ends on a content filter, which stops the loop where it is.
    yield* llm.push(reply().wait(deferredAsPromise(gate)).contentFilter())
    yield* llm.text("second answered")

    const a = yield* prompt
      .prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "first" }] })
      .pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const id = MessageID.ascending()
    const b = yield* prompt
      .prompt({
        sessionID: chat.id,
        messageID: id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "second" }],
      })
      .pipe(Effect.forkChild)
    yield* pollWithTimeout(
      sessions
        .messages({ sessionID: chat.id })
        .pipe(
          Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
        ),
      "timed out waiting for second prompt to save",
    )
    yield* Deferred.succeed(gate, void 0)
    yield* Effect.all([Fiber.await(a), Fiber.await(b)])

    expect(yield* llm.calls).toBe(2)
    const last = (yield* sessions.messages({ sessionID: chat.id })).at(-1)
    expect(last?.info.role === "assistant" && last.info.parentID).toBe(id)
  }),
)

it.instance("assertNotBusy fails with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    yield* llm.hang

    const chat = yield* sessions.create({})
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance("shell rejects with BusyError when loop running", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.hang
    yield* user(chat.id, "hi")

    const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
    yield* llm.wait(1)
    yield* waitForBusy(chat.id)

    const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
    }

    yield* prompt.cancel(chat.id)
    yield* Fiber.await(fiber)
  }),
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { trusted: true, config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { trusted: true, config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { trusted: true, config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { trusted: true, config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { trusted: true, config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { trusted: true, config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { trusted: true, config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* heldShell(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* sh.phase("loop-requested")
      // Observe the blocked loop while the real child is held by an explicit release signal.
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* sh.release
      const shellExit = yield* Fiber.await(sh.fiber)
      expect(Exit.isSuccess(shellExit), Exit.isFailure(shellExit) ? Cause.pretty(shellExit.cause) : "").toBe(true)
      if (Exit.isSuccess(shellExit)) {
        expect(completedTool(shellExit.value.parts)?.state.output).toContain("shell-released")
      }
      yield* sh.phase("child-exited-awaiting-loop")
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
      yield* sh.phase("loop-completed")
    }),
  { git: true },
  30_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* heldShell(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* sh.phase("loops-requested")
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* sh.release
      const shellExit = yield* Fiber.await(sh.fiber)
      expect(Exit.isSuccess(shellExit), Exit.isFailure(shellExit) ? Cause.pretty(shellExit.cause) : "").toBe(true)
      if (Exit.isSuccess(shellExit)) {
        expect(completedTool(shellExit.value.parts)?.state.output).toContain("shell-released")
      }
      yield* sh.phase("child-exited-awaiting-loops")
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
      yield* sh.phase("loops-completed")
    }),
  { git: true },
  30_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "command ! expansion respects shell permission denial",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, chat } = yield* boot()

        const exit = yield* prompt.command({ sessionID: chat.id, command: "blocked", arguments: "" }).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "slash-shell-bypass")).exists())).toBe(false)
      }),
    ),
  {
    trusted: true,
    git: true,
    config: {
      ...cfg,
      permission: { bash: "deny" },
      command: {
        blocked: {
          template: "Blocked: !`touch slash-shell-bypass`",
        },
      },
    },
  },
  30_000,
)

test("command arguments cannot inject shell interpolation", () => {
  const injected = "!`touch slash-argument-injection`"
  const prepared = SessionPrompt.prepareCommandTemplate("Inspect: $ARGUMENTS", injected, "/bin/sh")

  expect(prepared.shellCommands).toEqual([])
  expect(prepared.render([])).toContain(injected)
})

test("command snippets receive each argument as a quoted literal word", () => {
  const prepared = SessionPrompt.prepareCommandTemplate(
    "Diff: !`gh pr diff $1` all: !`echo $ARGUMENTS`\nAbout $1 and $2",
    `42 "it's; touch pwned"`,
    "/bin/sh",
  )

  expect(prepared.shellCommands).toEqual([`gh pr diff '42'`, `echo '42' 'it'\\''s; touch pwned'`])
  // Output is inserted as is: a placeholder printed by a snippet is not the template's.
  expect(prepared.render(["diff says $1", "echo says $ARGUMENTS"])).toBe(
    "Diff: diff says $1 all: echo says $ARGUMENTS\nAbout 42 and it's; touch pwned",
  )
})

test("command snippets quote arguments for PowerShell and refuse what cmd.exe cannot keep literal", () => {
  expect(SessionPrompt.prepareCommandTemplate("!`echo $1`", `"it's"`, "pwsh").shellCommands).toEqual([`echo 'it''s'`])
  expect(SessionPrompt.prepareCommandTemplate("!`echo $1`", "plain", "cmd").shellCommands).toEqual([`echo "plain"`])
  expect(() => SessionPrompt.prepareCommandTemplate("!`echo $1`", "%PATH%", "cmd")).toThrow("cmd")
  // A snippet that never uses the arguments is unaffected by one cmd.exe cannot quote.
  expect(SessionPrompt.prepareCommandTemplate("!`echo hi` $1", "%PATH%", "cmd").shellCommands).toEqual(["echo hi"])
})

unix(
  "command ! snippets from the user's config keep their arguments and run without asking",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          permission: { bash: "ask" },
          command: {
            greet: {
              template: "Said: !`printf '%s|' $1 $2`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "greet",
          arguments: `"a b" '$(touch slash-argument-injection)'`,
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("a b|$(touch slash-argument-injection)|")
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "slash-argument-injection")).exists())).toBe(false)
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".shell-ready")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: ": > '.shell-ready'; sleep 30" })
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          afs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
          "shell never created readiness marker",
        )

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { trusted: true, git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { trusted: true, git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { trusted: true, git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { trusted: true, git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { trusted: true, config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { trusted: true, config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "task-generated sensitive text attachments require read approval",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({
        title: "Child",
        parentID: parent.id,
        agent: "general",
        permission: [{ permission: "read", pattern: "task-secret.pem", action: "ask" }],
      })
      yield* writeText(path.join(directory, "task-secret.pem"), "TASK_ATTACHMENT_SECRET=hidden")
      const parts = yield* prompt.resolvePromptParts("Inspect @task-secret.pem")
      expect(parts.some((part) => part.type === "file")).toBe(true)

      const fiber = yield* prompt
        .prompt({ sessionID: child.id, agent: "general", model: ref, noReply: true, parts })
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        Effect.gen(function* () {
          const request = (yield* permission.list()).find((item) => item.permission === "read")
          if (request) return request
          const exit = fiber.pollUnsafe()
          if (!exit) return
          return yield* Effect.fail(
            new Error(
              `attachment prompt completed before approval: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : JSON.stringify(exit.value.parts)}`,
            ),
          )
        }),
        "task attachment did not request sensitive read permission",
        "15 seconds",
      )

      expect(request.patterns).toContain("task-secret.pem")
      yield* permission.reply({ requestID: request.id, reply: "reject" })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
    }),
  { trusted: true, git: true, config: cfg },
)

noLLMServer.instance(
  "task-generated external binary attachments require external-directory approval",
  () =>
    Effect.gen(function* () {
      const external = yield* tmpdirScoped()
      const image = path.join(external, "outside.png")
      const fsys = yield* FSUtil.Service
      yield* fsys.writeWithDirs(
        image,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
          "base64",
        ),
      )
      const prompt = yield* SessionPrompt.Service
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ title: "Child", parentID: parent.id, agent: "general" })
      const parts = yield* prompt.resolvePromptParts(`Inspect @${image}`)

      const fiber = yield* prompt
        .prompt({ sessionID: child.id, agent: "general", model: ref, noReply: true, parts })
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((items) => items.find((item) => item.permission === "external_directory"))),
        "task attachment did not request external-directory permission",
        "15 seconds",
      )

      expect(request.patterns.some((pattern) => pattern.includes(path.basename(external)))).toBe(true)
      yield* permission.reply({ requestID: request.id, reply: "reject" })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
    }),
  { trusted: true, config: cfg },
)

noLLMServer.instance(
  "client binary file parts outside the project require external-directory approval",
  () =>
    Effect.gen(function* () {
      const external = yield* tmpdirScoped()
      const secret = path.join(external, "outside.bin")
      const fsys = yield* FSUtil.Service
      yield* fsys.writeWithDirs(secret, "outside-binary-secret")
      const prompt = yield* SessionPrompt.Service
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const id = PartID.ascending()

      const fiber = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [
            { id, type: "file", mime: "application/octet-stream", filename: "outside.bin", url: `file://${secret}` },
          ],
        })
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((items) => items.find((item) => item.permission === "external_directory"))),
        "binary file part did not request external-directory permission",
        "15 seconds",
      )
      expect(request.patterns.some((pattern) => pattern.includes(path.basename(external)))).toBe(true)
      yield* permission.reply({ requestID: request.id, reply: "reject" })

      const exit = yield* Fiber.await(fiber)
      if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
      const stored = JSON.stringify(exit.value.parts)
      expect(stored).not.toContain(Buffer.from("outside-binary-secret").toString("base64"))
      expect(stored).not.toContain("file://")
      expect(exit.value.parts).toEqual([
        expect.objectContaining({ id, type: "text", text: expect.stringContaining("Read tool failed to read") }),
      ])
    }),
  { trusted: true, config: cfg },
)

noLLMServer.instance(
  "the user's own attachments outside the project attach without asking",
  () =>
    Effect.gen(function* () {
      const external = yield* tmpdirScoped()
      const binary = path.join(external, "photo.bin")
      const text = path.join(external, "notes.txt")
      const afs = yield* FSUtil.Service
      yield* afs.writeWithDirs(binary, "user-binary")
      yield* afs.writeWithDirs(text, "user-notes")
      const prompt = yield* SessionPrompt.Service
      const permission = yield* Permission.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const msg = yield* prompt.prompt(
        {
          sessionID: session.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [
            { type: "file", mime: "application/octet-stream", filename: "photo.bin", url: pathToFileURL(binary).href },
            { type: "file", mime: "text/plain", filename: "notes.txt", url: pathToFileURL(text).href },
          ],
        },
        { userFile: () => true },
      )

      expect(yield* permission.list()).toEqual([])
      expect(msg.parts).toContainEqual(
        expect.objectContaining({
          type: "file",
          url: `data:application/octet-stream;base64,${Buffer.from("user-binary").toString("base64")}`,
        }),
      )
      expect(JSON.stringify(msg.parts)).toContain("user-notes")
    }),
  { trusted: true, config: cfg },
)

noLLMServer.instance(
  "client binary file parts inside the project are still attached",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const inside = path.join(dir, "inside.bin")
      const fsys = yield* FSUtil.Service
      yield* fsys.writeWithDirs(inside, "inside-binary")
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "file", mime: "application/octet-stream", filename: "inside.bin", url: `file://${inside}` }],
      })

      expect(msg.parts).toContainEqual(
        expect.objectContaining({
          type: "file",
          url: `data:application/octet-stream;base64,${Buffer.from("inside-binary").toString("base64")}`,
        }),
      )
    }),
  { trusted: true, config: cfg },
)

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { trusted: true, config: cfg },
)

noLLMServer.instance(
  "keeps the client's file part and id when the Read tool fails",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "gone.ts")
      const id = PartID.ascending()
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @gone.ts" },
          { id, type: "file", mime: "text/plain", url: `file://${missing}`, filename: "gone.ts" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      // A client that shows the part while sending drops its copy only when a stored part with this id arrives.
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: msg.info.id })
      expect(stored.parts.filter((part) => part.type === "file").map((part) => part.id)).toEqual([id])

      yield* sessions.remove(session.id)
    }),
  { trusted: true, config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { trusted: true, config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { trusted: true, git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/engine/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance("records aborted errors when prompt is cancelled mid-stream", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt cancel regression" })

    yield* llm.hang

    const fiber = yield* prompt
      .prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Cancel me" }],
      })
      .pipe(Effect.forkChild)

    yield* llm.wait(1)
    yield* waitForBusy(session.id)
    yield* prompt.cancel(session.id)

    const exit = yield* Fiber.await(fiber)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.info.role).toBe("assistant")
      if (exit.value.info.role === "assistant") {
        expect(exit.value.info.error?.name).toBe("MessageAbortedError")
      }
    }

    const msgs = yield* sessions.messages({ sessionID: session.id })
    const last = msgs.findLast((msg) => msg.info.role === "assistant")
    expect(last?.info.role).toBe("assistant")
    if (last?.info.role === "assistant") {
      expect(last.info.error?.name).toBe("MessageAbortedError")
    }
  }),
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ref.providerID, modelID: ModelV2.ID.make("alternate-model") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("lmstudio"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    trusted: true,
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        lmstudio: {
          ...cfg.provider.lmstudio,
          models: {
            "alternate-model": {
              ...cfg.provider.lmstudio.models["test-model"],
              id: "alternate-model",
              name: "Alternate Model",
            },
            "test-model": {
              ...cfg.provider.lmstudio.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "lmstudio/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

const freeRef = { providerID: ProviderV2.ID.openrouter, modelID: ModelV2.ID.make(FREE_MODEL_FALLBACKS[0].id) }
const paidCommandConfig = {
  ...cfg,
  agent: {
    "paid-primary": { mode: "primary" as const, model: "lmstudio/test-model" },
    "paid-specialist": { mode: "subagent" as const, model: "lmstudio/test-model" },
  },
  command: {
    "paid-command": { template: "Inspect this change.", model: "lmstudio/test-model" },
    "paid-agent": { template: "Inspect this change.", agent: "paid-primary" },
    "paid-subtask": { template: "Inspect this change.", agent: "paid-specialist", subtask: true },
  },
}

freePrompts.instance(
  "free command selections survive configured command and agent models",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      for (const command of ["paid-command", "paid-agent", "paid-subtask"]) {
        for (const explicit of [false, true]) {
          const chat = yield* sessions.create({
            title: "Pinned",
            model: { providerID: freeRef.providerID, id: freeRef.modelID },
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const result = yield* prompt.command({
            sessionID: chat.id,
            command,
            arguments: "",
            ...(explicit ? { model: `${freeRef.providerID}/${freeRef.modelID}` } : {}),
          })
          expect(result.info).toMatchObject({ providerID: freeRef.providerID, modelID: freeRef.modelID })
          expect(result.parts).toContainEqual(
            expect.objectContaining({ type: "text", text: `openrouter/${freeRef.modelID}` }),
          )
          for (const message of yield* sessions.messages({ sessionID: chat.id })) {
            if (message.info.role === "assistant")
              expect(message.info).toMatchObject({ providerID: freeRef.providerID, modelID: freeRef.modelID })
          }
        }
      }
    }),
  { trusted: true, config: paidCommandConfig },
  30_000,
)

freePrompts.instance(
  "free parent ignores a paid model embedded in a subtask",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const result = yield* prompt.prompt({
        sessionID: chat.id,
        model: freeRef,
        parts: [{ type: "subtask", agent: "paid-specialist", prompt: "Inspect.", description: "inspect", model: ref }],
      })
      expect(result.info).toMatchObject({ providerID: freeRef.providerID, modelID: freeRef.modelID })
      const children = yield* sessions.children(chat.id)
      expect(children).toHaveLength(1)
      for (const message of yield* sessions.messages({ sessionID: children[0].id })) {
        if (message.info.role === "assistant")
          expect(message.info).toMatchObject({ providerID: freeRef.providerID, modelID: freeRef.modelID })
      }
    }),
  { trusted: true, config: paidCommandConfig },
)

freePrompts.instance(
  "omitted prompt models keep the current free selection while explicit paid selections work",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        model: { providerID: freeRef.providerID, id: freeRef.modelID },
      })
      const free = yield* prompt.prompt({ sessionID: chat.id, agent: "paid-primary", noReply: true, parts: [] })
      expect(free.info).toMatchObject({ model: freeRef })
      const paid = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "paid-primary",
        model: ref,
        noReply: true,
        parts: [],
      })
      expect(paid.info).toMatchObject({ model: ref })
      const command = yield* prompt.command({
        sessionID: chat.id,
        command: "paid-command",
        model: "lmstudio/test-model",
        arguments: "",
      })
      expect(command.info).toMatchObject({ providerID: ref.providerID, modelID: ref.modelID })
    }),
  { trusted: true, config: paidCommandConfig },
)

freePrompts.instance(
  "configured paid commands still work without a saved model or available default",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const provider = yield* ProviderSvc.Service
      expect(yield* provider.defaultModel().pipe(Effect.result)).toMatchObject({ _tag: "Failure" })
      const chat = yield* sessions.create({ title: "Pinned" })
      const result = yield* prompt.command({ sessionID: chat.id, command: "paid-command", arguments: "" })
      expect(result.info).toMatchObject({ providerID: ref.providerID, modelID: ref.modelID })
    }),
  {
    trusted: true,
    config: { ...paidCommandConfig, provider: { ...paidCommandConfig.provider, openrouter: { whitelist: [] } } },
  },
)

if (process.platform !== "win32")
  freePrompts.instance(
    "omitted shell models preserve the current free session",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          model: { providerID: freeRef.providerID, id: freeRef.modelID },
        })
        const result = yield* prompt.shell({ sessionID: chat.id, agent: "paid-primary", command: ":" })
        expect(result.info).toMatchObject({ providerID: freeRef.providerID, modelID: freeRef.modelID })
      }),
    { trusted: true, config: paidCommandConfig },
  )

trainingPrompts.instance(
  "an invited guest's prompt to a free model that may train is refused before it is saved, despite the owner's acceptance",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const laguna = { providerID: ProviderV2.ID.openrouter, modelID: ModelV2.ID.make(lagunaFree.id) }
      const chat = yield* sessions.create({ title: "Shared" })
      const parts = [{ type: "text" as const, text: "hello" }]
      // What the session handlers pass for an invited guest.
      const guest = { tightenBudget: true, refuseTrainingFreeModels: true }
      const refused = (exit: Exit.Exit<unknown, unknown>) => {
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        return NamedError.Unknown.isInstance(error) && error.data.message === FREE_MODEL_TRAINING_OWNER_ONLY
      }
      // Chosen explicitly.
      expect(
        refused(
          yield* prompt.prompt({ sessionID: chat.id, model: laguna, noReply: true, parts }, guest).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
      // The owner chose it for the session; a guest's prompt without a model would run on it.
      expect((yield* prompt.prompt({ sessionID: chat.id, model: laguna, noReply: true, parts })).info).toMatchObject({
        model: laguna,
      })
      expect(refused(yield* prompt.prompt({ sessionID: chat.id, noReply: true, parts }, guest).pipe(Effect.exit))).toBe(
        true,
      )
      expect(yield* sessions.messages({ sessionID: chat.id })).toHaveLength(1)
      // Resuming an interrupted turn runs it on the owner's account too.
      const resumed = yield* prompt
        .resumeFreeModels(
          { sessionID: chat.id, messageID: MessageID.ascending(), modelID: laguna.modelID },
          { refuseTrainingFreeModels: true },
        )
        .pipe(Effect.flip)
      expect(resumed).toMatchObject({ message: FREE_MODEL_TRAINING_OWNER_ONLY })
      // A no-training free model stays open to the guest.
      expect(
        (yield* prompt.prompt({ sessionID: chat.id, model: freeRef, noReply: true, parts }, guest)).info,
      ).toMatchObject({ model: freeRef })
    }),
  { trusted: true },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

// Vectorscope prompts its reviewers as the review and security specialists in helper sessions. Settings → Agents can
// turn every specialist off, which must not turn Vectorscope off with them.
it.instance(
  "a helper session still runs as its specialist when every specialist is turned off",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        ...providerCfg(url),
        agent: Object.fromEntries(NATIVE_SPECIALISTS.map((name) => [name, { disable: true }])),
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const helper = yield* sessions.create({ title: "Review", internal: "vectorscope.review" })
      yield* prompt.prompt({
        sessionID: helper.id,
        agent: "review",
        noReply: true,
        parts: [{ type: "text", text: "review this diff" }],
      })
      yield* llm.text("reviewed")

      const result = yield* prompt.loop({ sessionID: helper.id })

      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "reviewed")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
      // It ran as review: the specialist's own prompt went out with the request.
      expect(JSON.stringify((yield* llm.inputs)[0])).toContain("You are a senior code review specialist.")

      // A later turn of the helper still runs as review.
      yield* prompt.prompt({
        sessionID: helper.id,
        agent: "review",
        noReply: true,
        parts: [{ type: "text", text: "and this one" }],
      })
      yield* llm.text("reviewed again")
      const again = yield* prompt.loop({ sessionID: helper.id })
      expect(again.parts.some((part) => part.type === "text" && part.text === "reviewed again")).toBe(true)
      expect(JSON.stringify((yield* llm.inputs)[1])).toContain("You are a senior code review specialist.")

      // A session of the user's own still cannot reach a specialist that is turned off, by its own name or any other.
      const chat = yield* sessions.create({})
      for (const agent of ["review", "helper:review"]) {
        const exit = yield* prompt
          .prompt({ sessionID: chat.id, agent, noReply: true, parts: [{ type: "text", text: "review" }] })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause)
          expect(NamedError.Unknown.isInstance(err) && err.data.message).toContain(`Agent not found: "${agent}"`)
        }
        const shell = yield* prompt.shell({ sessionID: chat.id, agent, command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(shell)).toBe(true)
        if (Exit.isFailure(shell)) {
          const err = Cause.squash(shell.cause)
          expect(NamedError.Unknown.isInstance(err) && err.data.message).toContain(`Agent not found: "${agent}"`)
        }
      }
      expect(yield* llm.hits).toHaveLength(2)
    }),
  60_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)

it.instance(
  "one SDK task call launches both batch children before either returns",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = yield* Deferred.make<void>()
      yield* llm.tool("task", {
        background: false,
        tasks: [
          {
            description: "Inspect alpha",
            prompt: "Inspect alpha independently.",
            subagent_type: "general",
            owned_paths: ["alpha"],
            success_criteria: ["Report alpha evidence"],
          },
          {
            description: "Inspect beta",
            prompt: "Inspect beta independently.",
            subagent_type: "general",
            owned_paths: ["beta"],
            success_criteria: ["Report beta evidence"],
          },
        ],
      })
      yield* llm.hold("alpha verified", deferredAsPromise(gate))
      yield* llm.hold("beta verified", deferredAsPromise(gate))
      yield* llm.text("Both reports reviewed")
      yield* user(chat.id, "Inspect the two independent areas", "build", "thorough")
      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(3), "second child was serialized behind first completion", "8 seconds")
      expect(yield* sessions.children(chat.id)).toHaveLength(2)
      const during = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "task")
      expect(during).toHaveLength(1)
      yield* Deferred.succeed(gate, undefined)
      yield* awaitWithTimeout(Fiber.join(fiber), "batch and parent did not finish")
      const tasks = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "task")
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        state: {
          status: "completed",
          metadata: {
            taskBatch: 1,
            status: "completed",
            tasks: [
              { index: 0, status: "completed" },
              { index: 1, status: "completed" },
            ],
          },
        },
      })
      expect(yield* llm.calls).toBe(4)
      expect(yield* llm.pending).toBe(0)
    }),
  15_000,
)

for (const mode of ["legacy", "hybrid", "plugin-schema", "plugin-inplace", "legacy-extra"] as const) {
  it.instance(
    `SDK task compatibility validates ${mode} before execution hooks`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* TestInstance
        const log = path.join(fixture.directory, "task-hooks.txt")
        const plugin = path.join(fixture.directory, "task-schema-plugin.ts")
        yield* writeText(
          plugin,
          `export default async () => ({
      "tool.execute.before": async (input, output) => { if (input.tool === "task") await Bun.write(${JSON.stringify(log)}, JSON.stringify(output.args)); },
      ${
        mode === "plugin-schema"
          ? `"tool.definition": async (input, output) => {
        if (input.toolID === "task") output.jsonSchema = {
          type: "object", properties: { permit: { type: "string" } }, required: ["permit"]
        };
      },`
          : mode === "plugin-inplace"
            ? `"tool.definition": async (input, output) => { if (input.toolID === "task") output.jsonSchema.properties.route = { type: "string" }; },`
            : ""
      }
    })`,
        )
        const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), plugin: [pathToFileURL(plugin).href] }))
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const brief = {
          background: false,
          description: "Inspect legacy",
          prompt: "Inspect this independent area.",
          subagent_type: "general",
        }
        const valid = mode === "legacy" || mode === "legacy-extra"
        yield* llm.tool(
          "task",
          valid
            ? { ...brief, route: "preserved-plugin-context" }
            : { ...brief, tasks: [brief], route: "preserved-plugin-context" },
        )
        if (valid) yield* llm.text("child verified")
        yield* llm.text("parent verified tool outcome")
        yield* user(chat.id, "Inspect the assigned area", "build", "thorough")
        yield* prompt.loop({ sessionID: chat.id })
        expect(yield* Effect.promise(() => Bun.file(log).exists())).toBe(mode !== "hybrid")
        expect(yield* sessions.children(chat.id)).toHaveLength(valid ? 1 : 0)
        expect(yield* llm.calls).toBe(valid ? 3 : 2)
        if (mode !== "hybrid")
          expect(yield* Effect.promise(() => Bun.file(log).json())).toMatchObject({ route: "preserved-plugin-context" })
        if (valid) {
          const messages = yield* sessions.messages({ sessionID: chat.id })
          const part = messages
            .flatMap((message) => message.parts)
            .find((part) => part.type === "tool" && part.tool === "task")
          expect(part).toMatchObject({ state: { status: "completed", metadata: { sessionId: expect.any(String) } } })
          const bodies = yield* llm.inputs
          expect(bodies[0].tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                function: expect.objectContaining({
                  name: "task",
                  parameters: expect.objectContaining({ required: ["tasks"] }),
                }),
              }),
            ]),
          )
        }
      }),
    15_000,
  )
}

for (const mode of ["allow", "reject", "cancel", "definition", "override"] as const) {
  noLLMServer.instance(
    `native patch preserves SessionTools hooks, durable input and ${mode} behavior`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* TestInstance
        const patchText = "*** Begin Patch\n*** Add File: native-patch.txt\n+hello from patch\n*** End Patch"
        const log = path.join(fixture.directory, "hook-log.jsonl")
        const plugin = path.join(fixture.directory, "native-patch-plugin.ts")
        yield* writeText(
          plugin,
          `
          const log = ${JSON.stringify(log)};
          async function record(stage, args) {
            const file = Bun.file(log);
            const previous = await file.exists() ? await file.text() : "";
            await Bun.write(log, previous + JSON.stringify({ stage, args }) + "\\n");
          }
          export default async () => ({
            "tool.execute.before": async (input, output) => {
              if (input.tool === "apply_patch") await record("before", output.args);
            },
            "tool.execute.after": async (input) => {
              if (input.tool === "apply_patch") await record("after", input.args);
            },
            ${
              mode === "definition"
                ? `"tool.definition": async (input, output) => {
              if (input.toolID === "apply_patch") output.jsonSchema = {
                type: "object", properties: { patchText: { type: "string" }, extra: { type: "string" } },
                required: ["patchText", "extra"], additionalProperties: false
              };
            },`
                : ""
            }
            ${
              mode === "override"
                ? `tool: { apply_patch: {
              description: "Custom replacement", args: { patchText: { type: "string" } },
              execute: async () => "plugin replacement ran"
            } },`
                : ""
            }
          });
        `,
        )
        const state = { sent: false, bodies: [] as Record<string, unknown>[] }
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              async fetch(request) {
                const body = (await request.json()) as Record<string, unknown>
                state.bodies.push(body)
                const custom =
                  Array.isArray(body.tools) &&
                  body.tools.some((tool) => tool.name === "apply_patch" && tool.type === "custom")
                const args = { patchText, ...(mode === "definition" ? { extra: "required by plugin" } : {}) }
                const item = custom
                  ? {
                      type: "custom_tool_call",
                      id: "ctc_patch",
                      call_id: "patch_call",
                      name: "apply_patch",
                      input: patchText,
                    }
                  : {
                      type: "function_call",
                      id: "fc_patch",
                      call_id: "patch_call",
                      name: "apply_patch",
                      arguments: JSON.stringify(args),
                    }
                const first = !state.sent
                state.sent = true
                const frames = [
                  { type: "response.created", response: { id: "resp_patch", created_at: 1, model: "gpt-6.1-sol" } },
                  ...(first
                    ? [
                        { type: "response.output_item.added", output_index: 0, item },
                        custom
                          ? {
                              type: "response.custom_tool_call_input.delta",
                              output_index: 0,
                              item_id: item.id,
                              delta: patchText,
                            }
                          : {
                              type: "response.function_call_arguments.delta",
                              output_index: 0,
                              item_id: item.id,
                              delta: JSON.stringify(args),
                            },
                        { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
                      ]
                    : [
                        {
                          type: "response.output_item.added",
                          output_index: 0,
                          item: { type: "message", id: "msg_final" },
                        },
                        {
                          type: "response.output_text.delta",
                          item_id: "msg_final",
                          output_index: 0,
                          content_index: 0,
                          delta: "Done",
                        },
                        {
                          type: "response.output_item.done",
                          output_index: 0,
                          item: { type: "message", id: "msg_final" },
                        },
                      ]),
                  { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20 } } },
                ]
                return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
                  headers: { "content-type": "text/event-stream" },
                })
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        yield* writeConfig(fixture.directory, {
          enabled_providers: ["openai"],
          plugin: [pathToFileURL(plugin).href],
          model: "openai/gpt-6.1-sol",
          provider: {
            openai: {
              npm: "@ai-sdk/openai",
              options: { apiKey: "synthetic-local-only", baseURL: `${server.url.origin}/v1` },
              models: {
                "gpt-6.1-sol": {
                  ...cfg.provider.lmstudio.models["test-model"],
                  id: "gpt-6.1-sol",
                  options: { nativePatch: true },
                },
              },
            },
          },
        })
        // The project's provider, model and plugin load only once the workspace is trusted.
        yield* Effect.promise(() => trustWorkspace(fixture.directory))
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const permission = yield* Permission.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            ...(mode === "reject" || mode === "cancel"
              ? [{ permission: "edit", pattern: "*", action: "ask" as const }]
              : []),
          ],
        })
        const running = yield* prompt
          .prompt({
            sessionID: chat.id,
            model: { providerID: ProviderV2.ID.openai, modelID: ModelV2.ID.make("gpt-6.1-sol") },
            parts: [{ type: "text", text: "Create native-patch.txt" }],
          })
          .pipe(Effect.forkChild)
        if (mode === "reject" || mode === "cancel") {
          const request = yield* pollWithTimeout(
            permission
              .list()
              .pipe(
                Effect.map((items) => items.find((item) => item.sessionID === chat.id && item.permission === "edit")),
              ),
            "native patch did not request edit permission",
            "10 seconds",
          )
          expect(request.metadata).toMatchObject({
            files: [{ filePath: path.join(fixture.directory, "native-patch.txt"), type: "add" }],
          })
          if (mode === "reject") yield* permission.reply({ requestID: request.id, reply: "reject" })
          if (mode === "cancel") yield* prompt.cancel(chat.id)
        }
        yield* Fiber.join(running)
        const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
        const edited = parts.find((part) => part.type === "tool" && part.tool === "apply_patch")
        expect(edited).toMatchObject({
          type: "tool",
          callID: "patch_call",
          state: {
            status: mode === "reject" || mode === "cancel" ? "error" : "completed",
            input: { patchText },
          },
        })
        const hooks = (yield* Effect.promise(() => Bun.file(log).text()))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(hooks[0]).toMatchObject({ stage: "before", args: { patchText } })
        expect(hooks.map((hook) => hook.stage)).toEqual(
          mode === "reject" || mode === "cancel" ? ["before"] : ["before", "after"],
        )
        expect(state.bodies[0]).toMatchObject({
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: "apply_patch",
              type: mode === "definition" || mode === "override" ? "function" : "custom",
            }),
          ]),
        })
        const file = Bun.file(path.join(fixture.directory, "native-patch.txt"))
        if (mode === "reject" || mode === "cancel" || mode === "override")
          expect(yield* Effect.promise(() => file.exists())).toBe(false)
        if (mode === "allow" || mode === "definition")
          expect(yield* Effect.promise(() => file.text())).toBe("hello from patch\n")
        if (mode === "definition") expect(hooks[0].args.extra).toBe("required by plugin")
        if (mode === "override") expect(edited).toMatchObject({ state: { output: "plugin replacement ran" } })
        expect(yield* permission.list()).toEqual([])
      }),
    30_000,
  )
}

// Run guard: the test model priced through config, in USD per million tokens.
function pricedCfg(cost: { input: number; output: number; cache_read?: number }, extra: Partial<ConfigV1.Info> = {}) {
  return (url: string) => {
    const base = providerCfg(url)
    return {
      ...base,
      ...extra,
      provider: {
        ...base.provider,
        lmstudio: {
          ...base.provider.lmstudio,
          models: { "test-model": { ...base.provider.lmstudio.models["test-model"], cost } },
        },
      },
    }
  }
}

// A scripted reply whose usage also reports cache reads, which the chat protocol reads from prompt_tokens_details.
function cachedUsage(out: Reply, cached: number) {
  const item = out.item()
  if (item.type !== "sse") return item
  return {
    ...item,
    tail: item.tail.map((line) =>
      isRecord(line) && isRecord(line.usage)
        ? { ...line, usage: { ...line.usage, prompt_tokens_details: { cached_tokens: cached } } }
        : line,
    ),
  }
}

const budgetStop = (info: SessionV1.Info) =>
  info.role === "assistant" && info.error?.name === "BudgetStopError" ? info.error.data : undefined

const guardedChat = Effect.fn("test.guardedChat")(function* (budget?: { usd?: number; steps?: number }) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* prompt.prompt({
    sessionID: chat.id,
    agent: "build",
    noReply: true,
    // The full build harness: a generic prompt is Work, which offers no subagents.
    size: "thorough",
    parts: [{ type: "text", text: "go" }],
    ...(budget ? { budget } : {}),
  })
  return chat
})

it.instance(
  "run guard stops a priced run on the step that crosses the prompt's cap",
  () =>
    Effect.gen(function* () {
      // Each turn costs $0.10 of output, and the next step is estimated at $0.06, so turns one and two pass a $0.29
      // cap and turn three crosses it.
      const { llm } = yield* useServerConfig(pricedCfg({ input: 0, output: 100 }))
      const prompt = yield* SessionPrompt.Service
      const chat = yield* guardedChat({ usd: 0.29 })
      yield* llm.push(
        reply().tool("first", { value: 1 }).usage({ input: 100, output: 1000 }),
        reply().tool("second", { value: 2 }).usage({ input: 100, output: 1000 }),
        reply().tool("third", { value: 3 }).usage({ input: 100, output: 1000 }),
      )
      yield* llm.text("never requested")

      const result = yield* prompt.loop({ sessionID: chat.id })

      const stop = budgetStop(result.info)
      expect(stop?.reason).toBe("cap")
      expect(stop?.capUsd).toBe(0.29)
      expect(stop?.spentUsd).toBeCloseTo(0.3, 6)
      expect(stop?.message).toBe(
        "Spend cap reached: $0.30 spent against a $0.29 cap for this run. Vector stopped after the step that crossed it.",
      )
      expect(yield* llm.pending).toBe(1)
    }),
  120_000,
)

it.instance(
  "run guard holds a slash command to the budget sent with it",
  () =>
    Effect.gen(function* () {
      // The command's first turn costs $0.10 of output, past the $0.05 cap the command was sent with.
      const { llm } = yield* useServerConfig(
        pricedCfg({ input: 0, output: 100 }, { command: { probe: { template: "Probe the repository" } } }),
      )
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.push(reply().tool("first", { value: 1 }).usage({ input: 100, output: 1000 }))
      yield* llm.text("never requested")

      const result = yield* prompt.command({
        sessionID: chat.id,
        agent: "build",
        command: "probe",
        arguments: "",
        budget: { usd: 0.05 },
      })

      expect(budgetStop(result.info)?.reason).toBe("cap")
      expect(budgetStop(result.info)?.capUsd).toBe(0.05)
      expect(yield* llm.pending).toBe(1)
    }),
  60_000,
)

it.instance(
  "run guard stops before a step it predicts would cross the config cap",
  () =>
    Effect.gen(function* () {
      // Turn one costs $0.39 against a $0.40 cap from config. Its 20k-token context, 18k of it cached, prices the
      // next step at $0.74 at the cheapest, so the run stops before it.
      yield* useUserConfig({ budget: { run: { usd: 0.4 } } })
      const { llm } = yield* useServerConfig(pricedCfg({ input: 100, output: 100, cache_read: 10 }))
      const prompt = yield* SessionPrompt.Service
      const chat = yield* guardedChat()
      yield* llm.push(cachedUsage(reply().tool("first", { value: 1 }).usage({ input: 20_000, output: 100 }), 18_000))
      yield* llm.text("never requested")

      const result = yield* prompt.loop({ sessionID: chat.id })

      const stop = budgetStop(result.info)
      expect(stop?.reason).toBe("predicted")
      expect(stop?.spentUsd).toBeCloseTo(0.39, 6)
      expect(stop?.estimate).toBeDefined()
      if (!stop?.estimate) return
      expect(stop.estimate.lowUsd).toBeCloseTo(0.74, 6)
      expect(stop.estimate.lowUsd).toBeLessThanOrEqual(stop.estimate.highUsd)
      expect(stop.estimate.highUsd).toBeGreaterThan(stop.estimate.lowUsd)
      expect(yield* llm.pending).toBe(1)
    }),
  120_000,
)

it.instance(
  "run guard predicts the next step at the long-context rate its context will be billed at",
  () =>
    Effect.gen(function* () {
      // Turn one sends 198k tokens at $1/M, $0.198. The next step carries 201k, past the 200K tier, where input costs
      // $10/M: $2.01 against a $1.00 cap. At the base rate it would be $0.20 and the run would go on. Compaction is
      // off, since by default a session compacts before it crosses a price tier.
      const { llm } = yield* useServerConfig((url) => {
        const base = pricedCfg({ input: 1, output: 0 })(url)
        const model = base.provider.lmstudio.models["test-model"]
        return {
          ...base,
          compaction: { auto: false },
          provider: {
            ...base.provider,
            lmstudio: {
              ...base.provider.lmstudio,
              models: {
                "test-model": {
                  ...model,
                  limit: { context: 1_000_000, output: 10_000 },
                  cost: { input: 1, output: 0, context_over_200k: { input: 10, output: 0 } },
                },
              },
            },
          },
        }
      })
      const prompt = yield* SessionPrompt.Service
      const chat = yield* guardedChat({ usd: 1 })
      yield* llm.push(reply().tool("first", { value: 1 }).usage({ input: 198_000, output: 0 }))
      yield* llm.text("never requested")

      const result = yield* prompt.loop({ sessionID: chat.id })

      const stop = budgetStop(result.info)
      expect(stop?.reason).toBe("predicted")
      expect(stop?.spentUsd).toBeCloseTo(0.198, 6)
      expect(stop?.estimate?.lowUsd).toBeCloseTo(2.01, 6)
      expect(yield* llm.pending).toBe(1)
    }),
  60_000,
)

unix(
  "run guard pauses the same bash call repeated across turns",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const chat = yield* guardedChat()
        const call = { command: "echo loop", description: "Print loop" }
        yield* llm.tool("bash", call)
        yield* llm.tool("bash", call)
        yield* llm.tool("bash", call)
        yield* llm.text("never requested")

        const result = yield* prompt.loop({ sessionID: chat.id })

        const stop = budgetStop(result.info)
        expect(stop?.reason).toBe("loop")
        expect(stop?.message).toBe(
          "Paused a repeating loop: `bash` returned the same result for the same input 3 times, with no new results or file changes in between.",
        )
        expect(yield* llm.pending).toBe(1)
      }),
    ),
  120_000,
)

unix(
  "run guard leaves a repeated bash call alone while each run of it changes a file",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const chat = yield* guardedChat()
        // The same input every time, but every run appends to a file, which only the step's patch shows.
        const call = { command: "echo again >> stamp.txt", description: "Append a line" }
        yield* llm.tool("bash", call)
        yield* llm.tool("bash", call)
        yield* llm.tool("bash", call)
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: chat.id })

        expect(budgetStop(result.info)).toBeUndefined()
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
        expect(yield* llm.pending).toBe(0)
      }),
    ),
  { git: true },
  120_000,
)

unix(
  "run guard leaves a repeated bash call alone while it returns something new each time",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig(providerCfg)
        const prompt = yield* SessionPrompt.Service
        const chat = yield* guardedChat()
        // The same input every time, but each run prints the process ID of its own shell.
        const call = { command: "echo $$", description: "Print the shell's process ID" }
        yield* llm.tool("bash", call)
        yield* llm.tool("bash", call)
        yield* llm.tool("bash", call)
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: chat.id })

        expect(budgetStop(result.info)).toBeUndefined()
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
        expect(yield* llm.pending).toBe(0)
      }),
    ),
  120_000,
)

unix(
  "run guard leaves repeated calls alone when config turns the loop rules off",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          budget: { loop: { enabled: false } },
        }))
        const prompt = yield* SessionPrompt.Service
        const chat = yield* guardedChat()
        const call = { command: "echo loop", description: "Print loop" }
        yield* llm.tool("bash", call)
        yield* llm.tool("bash", call)
        yield* llm.tool("bash", call)
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: chat.id })

        expect(budgetStop(result.info)).toBeUndefined()
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
        expect(yield* llm.pending).toBe(0)
      }),
    ),
  120_000,
)

it.instance(
  "run guard counts a subagent's spend against the root and stops both",
  () =>
    Effect.gen(function* () {
      // The root's own step is free of tokens; the child's single step spends $2.00 of input against a $1.00 cap.
      const { llm } = yield* useServerConfig(pricedCfg({ input: 100, output: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const chat = yield* guardedChat({ usd: 1 })
      yield* llm.tool("task", {
        background: false,
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.push(reply().tool("lookup", { value: 1 }).usage({ input: 20_000, output: 0 }))
      yield* llm.text("never requested")

      const result = yield* prompt.loop({ sessionID: chat.id })

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      const childMessages = yield* MessageV2.filterCompactedEffect(kids[0]!.id)
      const childStop = childMessages.map((item) => budgetStop(item.info)).find((item) => item !== undefined)
      expect(childStop?.reason).toBe("cap")
      expect(childStop?.spentUsd).toBeCloseTo(2, 6)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.error?.name).toBe("BudgetStopError")
      expect(budgetStop(result.info)?.reason).toBe("cap")
      expect((yield* guard.snapshot(chat.id))?.spentUsd).toBeCloseTo(2, 6)
      expect(yield* llm.pending).toBe(1)
    }),
  120_000,
)

it.instance(
  "run guard without a budget or config leaves a multi-turn run unchanged",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const guard = yield* SpendGuard.Service
      const chat = yield* guardedChat()
      yield* llm.tool("first", { value: 1 })
      yield* llm.tool("second", { value: 2 })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(yield* llm.calls).toBe(3)
      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.error).toBeUndefined()
      expect(result.info.finish).toBe("stop")
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      const run = yield* guard.snapshot(chat.id)
      expect(run?.steps).toBe(3)
      expect(run?.stopped).toBeUndefined()
      expect(yield* guard.stopped(chat.id)).toBeUndefined()
    }),
  120_000,
)

it.instance(
  "run guard ignores a trusted repository's budget.run",
  () =>
    Effect.gen(function* () {
      // The repository allows one step; spend limits are the user's alone, so the run takes all three.
      const { llm } = yield* useServerConfig((url) => ({ ...providerCfg(url), budget: { run: { steps: 1 } } }))
      const prompt = yield* SessionPrompt.Service
      const guard = yield* SpendGuard.Service
      const chat = yield* guardedChat()
      yield* llm.tool("first", { value: 1 })
      yield* llm.tool("second", { value: 2 })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(yield* llm.calls).toBe(3)
      expect(budgetStop(result.info)).toBeUndefined()
      expect((yield* guard.snapshot(chat.id))?.budget).toEqual({})
    }),
  120_000,
)

// A request whose history carries `text` in a user message, which tells a subagent's requests from its root's.
const asksFor = (text: string) => (hit: { body: Record<string, unknown> }) =>
  Array.isArray(hit.body.messages) &&
  hit.body.messages.some(
    (message) => isRecord(message) && message.role === "user" && JSON.stringify(message.content).includes(text),
  )

it.instance(
  "run guard keeps a stopped step's tool calls in the next turn's history",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(pricedCfg({ input: 0, output: 100 }))
      const prompt = yield* SessionPrompt.Service
      const chat = yield* guardedChat({ usd: 0.05 })
      yield* llm.push(reply().tool("glob", { pattern: "**/*.nothing" }).usage({ input: 100, output: 1000 }))
      const stopped = yield* prompt.loop({ sessionID: chat.id })
      expect(budgetStop(stopped.info)?.reason).toBe("cap")

      yield* llm.text("done")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "Continue from where you stopped." }],
        budget: { usd: 5 },
      })

      const messages = (yield* llm.inputs).at(-1)?.messages
      expect(Array.isArray(messages)).toBe(true)
      if (!Array.isArray(messages)) return
      const call = messages
        .filter(isRecord)
        .flatMap((message) => (Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : []))
        .find((item) => isRecord(item.function) && item.function.name === "glob")
      expect(call).toBeDefined()
      expect(
        messages.some((message) => isRecord(message) && message.role === "tool" && message.tool_call_id === call?.id),
      ).toBe(true)
    }),
  120_000,
)

// Sends `text` while the session's run is going and waits until its user message is saved.
const joinRun = Effect.fn("test.joinRun")(function* (
  sessionID: SessionID,
  text: string,
  budget?: { usd?: number; steps?: number },
) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const id = MessageID.ascending()
  const fiber = yield* prompt
    .prompt({
      sessionID,
      messageID: id,
      agent: "build",
      parts: [{ type: "text", text }],
      ...(budget ? { budget } : {}),
    })
    .pipe(Effect.forkChild)
  yield* pollWithTimeout(
    sessions
      .messages({ sessionID })
      .pipe(
        Effect.map((msgs) => (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined)),
      ),
    "timed out waiting for the joining prompt to save",
  )
  return fiber
})

it.instance(
  "run guard leaves a prompt that joined a budget-stopped run for Continue",
  () =>
    Effect.gen(function* () {
      // The first step costs $0.10 against a $0.05 cap and calls a tool, so the guard ends the turn there.
      const { llm } = yield* useServerConfig(pricedCfg({ input: 0, output: 100 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const gate = yield* Deferred.make<void>()
      const chat = yield* guardedChat({ usd: 0.05 })
      yield* llm.push(
        reply().wait(deferredAsPromise(gate)).tool("first", { value: 1 }).usage({ input: 100, output: 1000 }),
      )
      yield* llm.text("never requested")

      const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)
      const joined = yield* joinRun(chat.id, "second")
      yield* Deferred.succeed(gate, void 0)
      yield* Fiber.join(running)
      const result = yield* Fiber.join(joined)

      expect(budgetStop(result.info)?.reason).toBe("cap")
      expect(yield* llm.calls).toBe(1)
      expect(yield* llm.pending).toBe(1)
      expect((yield* sessions.messages({ sessionID: chat.id })).at(-1)?.info.role).toBe("user")
    }),
  120_000,
)

it.instance(
  "run guard answers a prompt that joined a run which ended without reading it under the prompt's budget",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const guard = yield* SpendGuard.Service
      const gate = yield* Deferred.make<void>()
      const chat = yield* guardedChat({ usd: 1 })
      // The first turn ends on a content filter, which stops the loop before it reads the joining prompt.
      yield* llm.push(reply().wait(deferredAsPromise(gate)).contentFilter())
      yield* llm.text("second answered")

      const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* waitForBusy(chat.id)
      const joined = yield* joinRun(chat.id, "second", { usd: 3 })
      yield* Deferred.succeed(gate, void 0)
      yield* Fiber.join(running)
      const result = yield* Fiber.join(joined)

      expect(result.parts.some((part) => part.type === "text" && part.text === "second answered")).toBe(true)
      expect(yield* llm.calls).toBe(2)
      expect((yield* guard.snapshot(chat.id))?.budget.usd).toBe(3)
    }),
  120_000,
)

it.instance(
  "run guard ends a subagent that starts after its lineage was stopped, without a request",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const root = yield* sessions.create({ title: "Root" })
      const child = yield* sessions.create({ title: "Child", parentID: root.id })
      yield* guard.begin(root.id, { usd: 1 })
      yield* guard.record(root.id, {
        costUsd: 2,
        costKind: "priced",
        contextTokens: 0,
        cachedTokens: 0,
        continues: false,
        tools: [],
        patched: false,
      })
      yield* user(child.id, "hello")
      yield* llm.text("never requested")

      const result = yield* prompt.loop({ sessionID: child.id })

      expect(yield* llm.calls).toBe(0)
      expect(yield* guard.rootOf(child.id)).toBe(root.id)
      expect(budgetStop(result.info)?.reason).toBe("cap")
      expect(budgetStop(result.info)?.spentUsd).toBe(2)
    }),
  120_000,
)

it.instance(
  "run guard holds a subagent prompted while its root has no run to the config budget",
  () =>
    Effect.gen(function* () {
      // No run of the root ever began in this process, as after a restart. The config allows one step.
      yield* useUserConfig({ budget: { run: { steps: 1 } } })
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const root = yield* sessions.create({ title: "Root" })
      const child = yield* sessions.create({
        title: "Child",
        parentID: root.id,
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* user(child.id, "hello")
      yield* llm.tool("first", { value: 1 })
      yield* llm.text("never requested")

      const result = yield* prompt.loop({ sessionID: child.id })

      expect(budgetStop(result.info)?.reason).toBe("steps")
      expect(yield* llm.calls).toBe(1)
      expect((yield* guard.snapshot(child.id))?.budget).toEqual({ steps: 1 })
      // The run was the subagent's own, so the root's next run is not cut short by it.
      expect(yield* guard.snapshot(root.id)).toBeUndefined()
    }),
  120_000,
)

it.instance(
  "run guard runs a helper started after its session's run stopped under its own limits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const root = yield* sessions.create({ title: "Root" })
      yield* guard.begin(root.id, { usd: 1 })
      yield* guard.record(root.id, {
        costUsd: 2,
        costKind: "priced",
        contextTokens: 0,
        cachedTokens: 0,
        continues: false,
        tools: [],
        patched: false,
      })
      yield* guard.end(root.id)
      // A review the user asks for once the stopped run is over is a run of its own, not a part of the stopped one.
      const helper = yield* sessions.create({ title: "Review", parentID: root.id, internal: "vectorscope.security" })
      yield* user(helper.id, "review this")
      yield* llm.text("reviewed")

      const result = yield* prompt.loop({ sessionID: helper.id })

      expect(budgetStop(result.info)).toBeUndefined()
      expect(yield* llm.calls).toBe(1)
      expect(yield* guard.rootOf(helper.id)).toBe(helper.id)
      expect((yield* guard.snapshot(root.id))?.spentUsd).toBe(2)
    }),
  120_000,
)

it.instance(
  "run guard counts a helper started during its session's run against that run",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(pricedCfg({ input: 100, output: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const root = yield* sessions.create({ title: "Root" })
      yield* guard.begin(root.id, { usd: 5 })
      const helper = yield* sessions.create({ title: "Review", parentID: root.id, internal: "vectorscope.security" })
      yield* user(helper.id, "review this")
      yield* llm.push(reply().tool("lookup", { value: 1 }).usage({ input: 1_000, output: 0 }))
      yield* llm.text("reviewed")

      yield* prompt.loop({ sessionID: helper.id })

      expect(yield* guard.rootOf(helper.id)).toBe(root.id)
      expect((yield* guard.snapshot(root.id))?.spentUsd).toBeCloseTo(0.1, 6)
    }),
  120_000,
)

it.instance(
  "run guard decides a reused helper session's run each time it runs",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const root = yield* sessions.create({ title: "Root" })
      const helper = yield* sessions.create({
        title: "Autocomplete",
        parentID: root.id,
        internal: "codespace.autocomplete",
      })
      const crossed = {
        costUsd: 2,
        costKind: "priced",
        contextTokens: 0,
        cachedTokens: 0,
        continues: false,
        tools: [],
        patched: false,
      } satisfies SpendGuard.Step

      // During the root's run the helper counts there; the run then crosses its cap and ends.
      yield* guard.begin(root.id, { usd: 1 })
      yield* user(helper.id, "complete one")
      yield* llm.text("one")
      yield* prompt.loop({ sessionID: helper.id })
      expect(yield* guard.rootOf(helper.id)).toBe(root.id)
      yield* guard.record(root.id, crossed)
      yield* guard.end(root.id)

      // After that run, the same helper session runs under its own limits.
      yield* user(helper.id, "complete two")
      yield* llm.text("two")
      const after = yield* prompt.loop({ sessionID: helper.id })
      expect(budgetStop(after.info)).toBeUndefined()
      expect(yield* llm.calls).toBe(2)
      expect(yield* guard.rootOf(helper.id)).toBe(helper.id)
      expect((yield* guard.snapshot(root.id))?.steps).toBe(2)

      // The root's next run takes it back.
      yield* guard.begin(root.id, { usd: 5 })
      yield* user(helper.id, "complete three")
      yield* llm.text("three")
      yield* prompt.loop({ sessionID: helper.id })
      expect(yield* guard.rootOf(helper.id)).toBe(root.id)
      expect((yield* guard.snapshot(root.id))?.steps).toBe(1)
      yield* guard.end(root.id)
    }),
  120_000,
)

it.instance(
  "run guard marks the root's subtask turn stopped when its subagent crosses the cap",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(pricedCfg({ input: 100, output: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const msg = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "go" }],
        budget: { usd: 1 },
      })
      yield* addSubtask(chat.id, msg.info.id)
      yield* llm.push(reply().tool("lookup", { value: 1 }).usage({ input: 20_000, output: 0 }))
      yield* llm.text("never requested")

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.agent).toBe("general")
      expect(result.info.finish).toBe("tool-calls")
      expect(budgetStop(result.info)?.reason).toBe("cap")
      expect(budgetStop(result.info)?.spentUsd).toBeCloseTo(2, 6)
      expect(yield* llm.pending).toBe(1)
    }),
  120_000,
)

it.instance(
  "run guard predicts past a stop-finish step that still called tools",
  () =>
    Effect.gen(function* () {
      // Some providers finish "stop" with tool calls, and the loop goes on. Step one spends $0.60, and its 6k-token
      // context prices the next step at $0.60 or more, past what is left of a $1.00 cap.
      const { llm } = yield* useServerConfig(pricedCfg({ input: 100, output: 1 }))
      const prompt = yield* SessionPrompt.Service
      const chat = yield* guardedChat({ usd: 1 })
      yield* llm.push(reply().tool("first", { value: 1 }).stop().usage({ input: 6_000, output: 0 }))
      yield* llm.text("never requested")

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(budgetStop(result.info)?.reason).toBe("predicted")
      expect(yield* llm.pending).toBe(1)
    }),
  120_000,
)

it.instance(
  "run guard leaves a structured answer that crosses the cap without an error",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(pricedCfg({ input: 100, output: 1 }))
      const prompt = yield* SessionPrompt.Service
      const guard = yield* SpendGuard.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.push(reply().tool("StructuredOutput", { answer: 4 }).usage({ input: 20_000, output: 0 }))

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "What is 2 + 2?" }],
        format: new SessionV1.OutputFormatJsonSchema({
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
          retryCount: 0,
        }),
        budget: { usd: 1 },
      })

      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.error).toBeUndefined()
      expect(result.info.structured).toEqual({ answer: 4 })
      expect((yield* guard.snapshot(chat.id))?.stopped).toEqual({
        reason: "cap",
        message:
          "Spend cap reached: $2.00 spent against a $1.00 cap for this run, on a step that ended its turn. Its answer stands, and Vector starts no further step under this cap.",
      })
    }),
  120_000,
)

it.instance(
  "run guard counts a stored OAuth plan's steps as plan and never caps them in dollars",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(pricedCfg({ input: 100, output: 1 }))
      const prompt = yield* SessionPrompt.Service
      const guard = yield* SpendGuard.Service
      const auth = yield* Auth.Service
      yield* auth.set("lmstudio", {
        type: "oauth",
        refresh: "placeholder-refresh",
        access: "placeholder-access",
        expires: Date.now() + 3_600_000,
      })
      yield* Effect.addFinalizer(() => auth.remove("lmstudio").pipe(Effect.ignore))
      const chat = yield* guardedChat({ usd: 1 })
      yield* llm.push(reply().tool("first", { value: 1 }).usage({ input: 20_000, output: 0 }))
      yield* llm.text("done")

      const result = yield* prompt.loop({ sessionID: chat.id })

      expect(budgetStop(result.info)).toBeUndefined()
      const run = yield* guard.snapshot(chat.id)
      expect(run?.costKind).toBe("plan")
      expect(run?.spentUsd).toBe(0)
      expect(run?.stopped).toBeUndefined()
      expect(yield* llm.pending).toBe(0)
    }),
  120_000,
)

const withBackground = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, makeMcp()],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, backgroundSubagents: true })],
  ]),
)

withBackground.instance(
  "run guard stops a background subagent at its next step after the root's run stopped",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(pricedCfg({ input: 100, output: 1 }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const guard = yield* SpendGuard.Service
      const chat = yield* guardedChat({ usd: 1 })
      const gate = Promise.withResolvers<void>()
      const rootGate = Promise.withResolvers<void>()
      const child = asksFor("look into the cache key path")
      const root = (hit: { body: Record<string, unknown> }) => !child(hit)
      yield* llm.pushMatch(
        root,
        reply().tool("task", {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        }),
        // The root's second step spends $2.00 against the $1.00 cap while its subagent's first step is in flight.
        reply().wait(rootGate.promise).tool("first", { value: 1 }).usage({ input: 20_000, output: 0 }),
      )
      yield* llm.pushMatch(
        child,
        reply().wait(gate.promise).tool("lookup", { value: 1 }).usage({ input: 10, output: 0 }),
        reply().text("never requested").stop(),
      )

      const running = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      // The root's second step answers only once the subagent's first request is in flight.
      yield* llm.wait(3)
      rootGate.resolve()
      const result = yield* Fiber.join(running)
      expect(budgetStop(result.info)?.reason).toBe("cap")
      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      gate.resolve()

      const childStop = yield* pollWithTimeout(
        MessageV2.filterCompactedEffect(kids[0]!.id).pipe(
          Effect.map((messages) => messages.map((item) => budgetStop(item.info)).find((item) => item !== undefined)),
        ),
        "the background subagent never stopped",
      )
      expect(childStop.reason).toBe("cap")
      // The late result is recorded on the root without starting an uncapped turn.
      yield* pollWithTimeout(
        MessageV2.filterCompactedEffect(chat.id).pipe(
          Effect.map((messages) =>
            messages.findLast((item) =>
              item.parts.some((part) => part.type === "text" && part.text.includes("Background task")),
            ),
          ),
        ),
        "the background result never reached the root",
      )
      // A reply to the result would start right after it lands; give one the chance to show up.
      yield* Effect.sleep("300 millis")
      const latest = (yield* MessageV2.filterCompactedEffect(chat.id)).at(-1)
      expect(latest?.info.role).toBe("user")
      expect(yield* llm.calls).toBe(3)
      expect(yield* llm.pending).toBe(1)
      expect((yield* guard.snapshot(chat.id))?.steps).toBe(3)
    }),
  120_000,
)
