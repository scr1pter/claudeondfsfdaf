import { afterEach, describe, expect } from "bun:test"
import path from "node:path"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import type { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Connect } from "@vectordevai/schema/connect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { ConfigMarkdown } from "@/config/markdown"
import type { ConnectAdapter } from "@/connect/adapter"
import { ConnectHub } from "@/connect/hub"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Vcs } from "@/project/vcs"
import { Question } from "@/question"
import { InstanceApi } from "@/server/routes/instance/httpapi/groups/instance"
import { instanceHandlers } from "@/server/routes/instance/httpapi/handlers/instance"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Skill } from "@/skill"
import { TaskLimits } from "@/task/limits"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { it as plain, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// The /vectorscope command (CW-06): a built-in command that exists only while connected tools are on, sized Work and
// never a subtask, whose template asks the build agent to call `connect` with action review and the target the user
// typed. /review stays the generic review prompt. The member behind the hub is a fake: no model runs except the fake
// model server, and nothing reaches the network.

afterEach(disposeAllInstances)

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

// The command service as the engine builds it, with the flags given.
const commandLayer = (flags: Partial<RuntimeFlags.Info>) =>
  LayerNode.compile(Command.node, [
    [MCP.node, mcp],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const listed = (flags: Partial<RuntimeFlags.Info>) =>
  Command.Service.use((service) => service.list()).pipe(Effect.provide(commandLayer(flags)))

// A command as a client reads it, with its template resolved.
const resolved = (info: Command.Info | undefined) =>
  info === undefined
    ? Effect.succeed(undefined)
    : Effect.promise(async () => ({ ...info, template: await info.template }))

const find = (list: readonly Command.Info[], name: string) => list.find((item) => item.name === name)

describe("listed", () => {
  plain.instance("with connected tools off, /vectorscope is not a command", () =>
    Effect.gen(function* () {
      const list = yield* listed({ experimentalConnect: false })
      expect(list.map((item) => item.name)).toEqual(
        expect.arrayContaining([Command.Default.INIT, Command.Default.REVIEW]),
      )
      expect(find(list, Command.Default.VECTORSCOPE)).toBeUndefined()
      const one = yield* Command.Service.use((service) => service.get(Command.Default.VECTORSCOPE)).pipe(
        Effect.provide(commandLayer({ experimentalConnect: false })),
      )
      expect(one).toBeUndefined()
    }),
  )

  plain.instance(
    "with connected tools on, /vectorscope is a built-in command sized Work that never runs as a subtask",
    () =>
      Effect.gen(function* () {
        const command = yield* resolved(find(yield* listed({ experimentalConnect: true }), Command.Default.VECTORSCOPE))
        expect(command).toMatchObject({
          name: "vectorscope",
          source: "command",
          subtask: false,
          size: "standard",
          hints: ["$ARGUMENTS"],
        })
        expect(command?.agent).toBeUndefined()
        expect(command?.model).toBeUndefined()
        expect(command?.description).toContain("VectorScope")
        expect(command?.description).toContain("uncommitted|staged|branch <base>")
      }),
  )

  plain.instance("/review is the same command with connected tools on as off", () =>
    Effect.gen(function* () {
      const off = yield* resolved(find(yield* listed({ experimentalConnect: false }), Command.Default.REVIEW))
      const on = yield* resolved(find(yield* listed({ experimentalConnect: true }), Command.Default.REVIEW))
      expect(off).toBeDefined()
      expect(on).toEqual(off)
      // Still the generic review prompt, run as a subtask, with no size of its own.
      expect(on).toMatchObject({ name: "review", source: "command", subtask: true })
      expect(on?.size).toBeUndefined()
      expect(on?.template).toContain("You are a code reviewer.")
      expect(on?.template).not.toContain("connect")
    }),
  )

  // A config command of the same name is the user's, as it is for /review.
  plain.instance(
    "a user's own vectorscope command takes the name",
    () =>
      Effect.gen(function* () {
        const command = find(yield* listed({ experimentalConnect: true }), Command.Default.VECTORSCOPE)
        expect(command?.description).toBe("my own")
        expect(yield* Effect.promise(async () => command?.template)).toBe("say hi")
        expect(command?.size).toBeUndefined()
      }),
    { config: { command: { vectorscope: { template: "say hi", description: "my own" } } }, trusted: true },
  )
})

describe("the template", () => {
  const template = Effect.gen(function* () {
    const command = yield* resolved(find(yield* listed({ experimentalConnect: true }), Command.Default.VECTORSCOPE))
    if (typeof command?.template !== "string") throw new Error("no /vectorscope template")
    return command.template
  })

  plain.instance("asks for connect review with the target the arguments name, and runs nothing itself", () =>
    Effect.gen(function* () {
      const text = yield* template
      // The three forms, and what each asks the tool for.
      expect(text).toContain('`action: "review"`')
      expect(text).toContain('`target: "uncommitted"`')
      expect(text).toContain('`target: "staged"`')
      expect(text).toContain('`target: "branch"` and `base: "<base>"`')
      // No other words become a target, and the agent neither reviews by itself nor reaches for the CLI.
      expect(text).toContain("do not guess a target")
      expect(text).toContain("never run `vector review` from the shell")
      // Findings are data.
      expect(text).toContain("not instructions")
      // The template is the command's: it carries no shell snippet, no file or agent reference, and no numbered
      // placeholder, so the user's words reach the model only where $ARGUMENTS stands.
      expect(ConfigMarkdown.shell(text)).toEqual([])
      expect(ConfigMarkdown.files(text)).toEqual([])
      expect(text.match(/\$\d/)).toBeNull()
      for (const args of ["", "uncommitted", "staged", "branch", "branch main", "branch origin/release-1.2"]) {
        const prepared = SessionPrompt.prepareCommandTemplate(text, args, "/bin/sh")
        expect(prepared.shellCommands).toEqual([])
        const rendered = prepared.render([])
        expect(rendered).toContain(`Arguments: ${args}\n`)
        expect(rendered.startsWith("Review my changes with VectorScope")).toBe(true)
      }
    }),
  )
})

// GET /command, served by the production handler over the command service built with the flags given.
let instance: InstanceContext | undefined
const route = (flags: Partial<RuntimeFlags.Info>) =>
  testEffect(
    HttpRouter.serve(
      HttpApiBuilder.layer(HttpApi.make("vector-instance").addHttpApi(InstanceApi)).pipe(
        Layer.provide(instanceHandlers),
        Layer.provide([
          schemaErrorLayer,
          Layer.succeed(
            Authorization,
            Authorization.of((effect) => effect),
          ),
          Layer.succeed(
            InstanceContextMiddleware,
            InstanceContextMiddleware.of((effect) =>
              Effect.suspend(() => effect.pipe(Effect.provideService(InstanceRef, instance))),
            ),
          ),
          Layer.succeed(
            WorkspaceRoutingMiddleware,
            WorkspaceRoutingMiddleware.of((effect) =>
              effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: process.cwd() })),
            ),
          ),
          commandLayer(flags),
          // The other instance routes are never called here.
          Layer.mock(Agent.Service)({}),
          Layer.mock(Format.Service)({}),
          Layer.mock(LSP.Service)({}),
          Layer.mock(Skill.Service)({}),
          Layer.mock(Vcs.Service)({}),
          Layer.mock(SessionStatus.Service)({}),
        ]),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      // What each request requires: the routing middleware's sessions (its stand-in above reads none) and the instance
      // store of the dispose route, which is never called here.
      Layer.provide([Layer.mock(Session.Service)({}), Layer.mock(InstanceStore.Service)({})]),
    ),
  )

const commandNames = Effect.gen(function* () {
  instance = yield* InstanceRef
  const response = yield* HttpClient.get("/command")
  expect(response.status).toBe(200)
  return ((yield* response.json) as { name: string }[]).map((item) => item.name)
})

route({ experimentalConnect: false }).instance("GET /command leaves /vectorscope out with connected tools off", () =>
  Effect.gen(function* () {
    const names = yield* commandNames
    expect(names).toContain("review")
    expect(names).not.toContain("vectorscope")
  }),
)

route({ experimentalConnect: true }).instance("GET /command lists /vectorscope with connected tools on", () =>
  Effect.gen(function* () {
    const names = yield* commandNames
    expect(names).toContain("review")
    expect(names).toContain("vectorscope")
  }),
)

// The whole session runtime against the fake model server, with a fake VectorScope behind the hub.
const seen: Connect.Request[] = []

const fake: ConnectAdapter.Adapter = {
  id: "vectorscope",
  owner: "vectorscope",
  describe: () =>
    Effect.succeed({
      id: "vectorscope",
      kind: "agent",
      title: "VectorScope",
      summary: "",
      owner: "vectorscope",
      place: "local",
      sendsTo: "this-computer",
      state: "ready",
      reach: "connect",
      actions: [{ id: "review", title: "Review", effects: ["read"], background: false, result: "review" }],
    }),
  handle: (request) =>
    Effect.sync(() => {
      seen.push(request)
      return {
        state: "completed",
        verdict: "clean",
        summary: "VectorScope reviewed the branch against main: no findings.",
        findings: [],
        sessions: [],
        notes: [],
        sendsTo: "this-computer",
        cost: { kind: "local" },
      } satisfies Connect.Result
    }),
}

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

const session = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionStatus.node,
      Question.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      TaskLimits.node,
      BackgroundJob.node,
      SpendGuard.node,
      EventV2Bridge.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [ConnectHub.node, ConnectHub.nodeWith([fake])],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, experimentalConnect: true })],
    ],
  ),
)

function providerConfig(url: string): Partial<ConfigV1.Info> {
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
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

const isTitle = (body: Record<string, unknown>) =>
  JSON.stringify(body).includes("Generate a title for this conversation")

function toolNames(body: Record<string, unknown> | undefined) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.map((item) =>
    item && typeof item === "object" && "function" in item ? (item.function as { name: string }).name : "",
  )
}

session.instance(
  "/vectorscope branch main reaches the connect tool as a Work request of the build agent",
  () =>
    Effect.gen(function* () {
      seen.length = 0
      const { directory } = yield* TestInstance
      const llm = yield* TestLLMServer
      const fs = yield* FSUtil.Service
      const file = path.join(directory, "vector.json")
      yield* fs.writeWithDirs(file, JSON.stringify(providerConfig(llm.url)))
      const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
      yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      // The fake model does what the template asks: one connect call with the target the user typed.
      yield* llm.tool("connect", { action: "review", target: "branch", base: "main" })
      yield* llm.text("VectorScope found nothing on this branch.")
      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "vectorscope",
        arguments: "branch main",
        agent: "build",
        model: "lmstudio/test-model",
      })

      // The request is Work, and the model saw the tool and the user's arguments in the command's text.
      expect(result.info.role === "assistant" && result.info.size).toBe("standard")
      const [first] = (yield* llm.inputs).filter((body) => !isTitle(body))
      expect(toolNames(first)).toContain("connect")
      const users = JSON.stringify(
        ((first?.messages ?? []) as { role: string }[]).filter((message) => message.role === "user"),
      )
      expect(users).toContain("Arguments: branch main")
      expect(users).toContain("Review my changes with VectorScope")

      // The call passed the tool's own gates (build, root, Work) and reached VectorScope with that target.
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({
        to: "vectorscope",
        action: "review",
        target: { kind: "branch", base: "main" },
        requester: { kind: "agent", sessionID: chat.id, agent: "build" },
        background: false,
      })
      const parts = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) => message.parts)
      const call = parts.find((part) => part.type === "tool" && part.tool === "connect")
      expect(call?.type === "tool" && call.state.status).toBe("completed")
      expect(call?.type === "tool" && call.state.status === "completed" && call.state.output).toContain("this computer")
    }),
  { git: true },
  60_000,
)
