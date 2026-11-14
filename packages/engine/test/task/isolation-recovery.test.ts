import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Database } from "@vectordevai/core/database/database"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Global } from "@vectordevai/core/global"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { InstanceHooks } from "@/project/instance-hooks"
import { Question } from "@/question"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SessionTaskSize } from "@/session/task-size"
import { TaskManager } from "@/task/manager"
import { TaskRecovery } from "@/task/recovery"
import { TaskIsolation } from "@/task/isolation"
import { Worktree } from "@/worktree"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { Agent } from "@/agent/agent"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { isRecord } from "@/util/record"
import { requireInstance, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// Isolation recovery (WP28) runs beside restart recovery and must never save or retire work that something may still be
// running: neither a slow start in this process nor another engine's checkout on the same data folder. A record is
// reconciled only once its job row names an owner that is gone.

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
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      TaskRecovery.node,
      InstanceHooks.node,
      TaskIsolation.node,
      Worktree.node,
      InstanceStore.node,
      Git.node,
      Agent.node,
      TaskManager.node,
      SessionPrompt.node,
      Session.node,
      SessionStatus.node,
      Question.node,
      Ripgrep.node,
      FSUtil.node,
      Database.node,
      BackgroundJob.node,
      BackgroundJobStore.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
      // Notes reach an idle parent after 50 ms of quiet here.
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, noteQuietMs: 50, noteHoldMs: 300 })],
    ],
  ),
)

const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

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

const setup = Effect.fn("IsolationRecoveryTest.setup")(function* () {
  const { directory } = yield* TestInstance
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  const file = path.join(directory, "vector.json")
  yield* fs.writeWithDirs(file, JSON.stringify(providerConfig(llm.url)))
  const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(directory, [file]))
  yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  return {
    directory,
    llm,
    sessions: yield* Session.Service,
    store: yield* BackgroundJobStore.Service,
    recovery: yield* TaskRecovery.Service,
    isolation: yield* TaskIsolation.Service,
  }
})

describe("isolation recovery", () => {
  it.instance(
    "a reserved isolated task is left alone while its owner may run it, and cleaned up once the owner is gone",
    () =>
      Effect.gen(function* () {
        const f = yield* setup()
        const home = yield* InstanceState.context
        const agents = yield* Agent.Service
        const agent = yield* agents.get("general")
        if (!agent) throw new Error("general agent unavailable")
        const parent = yield* f.sessions.create({ title: "Recovery parent" })
        const child = yield* f.sessions.create({ parentID: parent.id, title: "Recovery child" })
        yield* f.isolation.reserve({ taskID: child.id, parentSessionID: parent.id, title: "Recovery", agent })
        const state = () => f.isolation.get(child.id).pipe(Effect.map((record) => record.state))

        // No row yet (its job's first write may still be pending): nothing can tell, so it is left alone.
        yield* f.recovery.reconcile()
        expect(yield* state()).toBe("preparing")

        // A running engine on this machine holds the row's lease (here, this test's own live process).
        const here = BackgroundJobStore.current()
        const row = {
          id: child.id,
          type: "task",
          parentSessionID: parent.id,
          sessionID: child.id,
          directory: home.directory,
          background: true,
          startedAt: Date.now(),
          attempt: 1,
        }
        const live = { ...here, runtime: `${crypto.randomUUID()}:${crypto.randomUUID()}`, pid: process.pid }
        yield* f.store.started({ ...row, owner: live })
        yield* f.recovery.reconcile()
        expect(yield* state()).toBe("preparing")

        // An owner without a lease is gone: the interrupted preparation, which created nothing, is closed.
        yield* f.store.started({ ...row, owner: { ...live, runtime: "stopped-engine" } })
        yield* f.recovery.reconcile()
        expect(yield* state()).toBe("unchanged")
        expect(yield* f.llm.calls).toBe(0)
      }),
    { git: true },
  )
})

describe("isolation recovery without its row", () => {
  it.instance(
    "a stale earlier row never decides for a newer attempt; without a row the child's own owner does",
    () =>
      Effect.gen(function* () {
        const f = yield* setup()
        const home = yield* InstanceState.context
        const agents = yield* Agent.Service
        const agent = yield* agents.get("general")
        if (!agent) throw new Error("general agent unavailable")
        const parent = yield* f.sessions.create({ title: "Rowless parent" })
        const lifecycle = (owner: { runtimeID: string; owner?: { pid: number; boot: number } }) => ({
          kind: "subagent",
          custom: false,
          agent: "general",
          title: "Rowless child",
          parentSessionID: parent.id,
          parentMessageID: MessageID.ascending(),
          model: ref,
          background: true,
          status: "running",
          startedAt: Date.now(),
          attempt: 2,
          ...owner,
        })
        const here = BackgroundJobStore.current()
        // Attempt 2 belongs to another live engine on this machine whose row write has not landed (or failed).
        const child = yield* f.sessions.create({
          parentID: parent.id,
          title: "Rowless child",
          metadata: {
            [SubagentLifecycle.METADATA_KEY]: lifecycle({
              runtimeID: `${crypto.randomUUID()}:${crypto.randomUUID()}`,
              owner: { pid: process.pid, boot: here.boot },
            }),
          },
        })
        yield* f.isolation.reserve({
          taskID: child.id,
          parentSessionID: parent.id,
          title: "Rowless",
          agent,
          attempt: 2,
        })
        const state = () => f.isolation.get(child.id).pipe(Effect.map((record) => record.state))
        // Attempt 1's row names an engine that is gone; it says nothing about who runs attempt 2.
        yield* f.store.started({
          id: child.id,
          type: "task",
          parentSessionID: parent.id,
          sessionID: child.id,
          directory: home.directory,
          background: true,
          startedAt: Date.now(),
          attempt: 1,
          owner: { ...here, runtime: "stopped-engine" },
        })
        yield* f.recovery.reconcile()
        expect(yield* state()).toBe("preparing")

        // Once the child's own record names an owner that is gone, the record is recovered although no row exists.
        yield* f.sessions.setMetadata({
          sessionID: child.id,
          metadata: { [SubagentLifecycle.METADATA_KEY]: lifecycle({ runtimeID: "gone:engine" }) },
        })
        yield* f.recovery.reconcile()
        expect(yield* state()).toBe("unchanged")
        expect(yield* f.llm.calls).toBe(0)
      }),
    { git: true },
  )
})

describe("isolation recovery failures", () => {
  it.instance(
    "an unreadable isolation registry still lets an ordinary interrupted helper be reported",
    () =>
      Effect.gen(function* () {
        const f = yield* setup()
        const home = yield* InstanceState.context
        // The project's registry root is a symbolic link, which the registry guard refuses, so listing isolation
        // records fails outright.
        const registry = path.join(Global.Path.data, "task-isolation", home.project.id)
        const elsewhere = path.join(Global.Path.data, "redirected-isolation")
        yield* Effect.promise(async () => {
          await fs.mkdir(elsewhere, { recursive: true })
          await fs.mkdir(path.dirname(registry), { recursive: true })
          // A real directory symlink on every platform (hosted Windows runners can create one), so this is the Windows
          // proof that the guard refuses one; the admission case covers a junction.
          await fs.symlink(elsewhere, registry, "dir")
        })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            // unlink drops only the link, where Bun's rm fails on a link to a folder on Windows.
            await fs.unlink(registry).catch((cause) => {
              if (cause?.code !== "ENOENT") throw cause
            })
            await fs.rm(elsewhere, { recursive: true, force: true })
          }),
        )
        expect(yield* f.isolation.records().pipe(Effect.flip)).toMatchObject({ code: "registry" })
        const root = yield* f.sessions.create({ title: "Recovery root" })
        const gone = "stopped-engine"
        const helper = yield* f.sessions.create({
          parentID: root.id,
          metadata: {
            [SubagentLifecycle.METADATA_KEY]: {
              kind: "subagent",
              custom: false,
              agent: "general",
              title: "Ordinary helper",
              parentSessionID: root.id,
              parentMessageID: MessageID.ascending(),
              model: ref,
              background: true,
              status: "running",
              startedAt: Date.now(),
              runtimeID: gone,
              attempt: 1,
            },
          },
        })
        const here = BackgroundJobStore.current()
        yield* f.store.started({
          id: helper.id,
          type: "task",
          parentSessionID: root.id,
          sessionID: helper.id,
          directory: home.directory,
          background: true,
          startedAt: Date.now(),
          attempt: 1,
          owner: { ...here, runtime: gone },
        })

        expect((yield* f.recovery.reconcile()).reported).toBe(1)
        const record = SubagentLifecycle.read(yield* f.sessions.get(helper.id))
        expect(record).toMatchObject({ status: "cancelled", interruption: { reportedAt: expect.any(Number) } })
        expect(yield* f.llm.calls).toBe(0)
      }),
    { git: true },
  )
})
