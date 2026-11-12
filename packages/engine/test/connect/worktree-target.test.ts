import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { Npm } from "@vectordevai/core/npm"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Connect } from "@vectordevai/schema/connect"
import { Agent } from "@/agent/agent"
import { ConnectHub } from "@/connect/hub"
import { ConnectPlacement } from "@/connect/placement"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { TaskClaims } from "@/task/claims"
import { TaskIsolation } from "@/task/isolation"
import { TaskPlace } from "@/task/place"
import type { TaskPromptOps } from "@/tool/task"
import { FileLock } from "@/tool/file-lock"
import type { Tool } from "@/tool/tool"
import { Worktree } from "@/worktree"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, trustWorkspace, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

afterEach(disposeAllInstances)

const summaryLayer = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lspLayer = Layer.succeed(
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

const mcpLayer = Layer.succeed(
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
    startAuth: () => Effect.die("unexpected MCP auth in connect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in connect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in connect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const live = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ConnectHub.node,
      SessionPrompt.node,
      Session.node,
      SpendGuard.node,
      Agent.node,
      Git.node,
      InstanceStore.node,
      Worktree.node,
      TaskIsolation.node,
      SessionStatus.node,
      LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
    ]),
    [
      [SessionSummary.node, summaryLayer],
      [LSP.node, lspLayer],
      [MCP.node, mcpLayer],
      [Npm.node, NpmTest.noop],
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalConnect: true, experimentalEventSystem: true })],
    ],
  ),
)

const model = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }
const write = (directory: string, file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await fs.writeFile(path.join(directory, file), text)
  })
const git = Effect.fn("ConnectWorktreeTest.git")(function* (directory: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd: directory })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.text().trim()
})
const fixture = Effect.gen(function* () {
  const home = yield* InstanceState.context
  const llm = yield* TestLLMServer
  const provider = testProviderConfig(llm.url)
  provider.provider.lmstudio.models["test-model"].cost = { input: 1, output: 1 }
  yield* git(home.directory, ["config", "core.autocrlf", "false"])
  yield* write(home.directory, "vector.json", JSON.stringify({ ...provider, model: "lmstudio/test-model" }))
  yield* write(home.directory, "probe.txt", "PARENT_ONLY_CONTENT\n")
  yield* git(home.directory, ["add", "-A"])
  yield* git(home.directory, ["commit", "-qm", "base"])
  yield* Effect.promise(() => trustWorkspace(home.directory))
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const isolation = yield* TaskIsolation.Service
  const agents = yield* Agent.Service
  const hub = yield* ConnectHub.Service
  const store = yield* InstanceStore.Service
  const parent = yield* sessions.create({ title: "Task owner" })
  const child = yield* sessions.create({ title: "Isolated work", parentID: parent.id })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: parent.id,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: parent.id,
    messageID: user.id,
    type: "text",
    text: "Review this task.",
  })
  const agent = yield* agents.get("general")
  const recordPath = path.join(Global.Path.data, "task-isolation", home.project.id, child.id)
  const workPath = path.join(Global.Path.data, "task-worktree", home.project.id, child.id)
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* store.disposeDirectory(workPath)
      yield* git(home.directory, ["worktree", "remove", "--force", workPath]).pipe(Effect.catchCause(() => Effect.void))
      yield* git(home.directory, ["branch", "-D", `vector/subagent/${child.id}`]).pipe(
        Effect.catchCause(() => Effect.void),
      )
      yield* Effect.promise(() => fs.rm(recordPath, { recursive: true, force: true }))
      TaskClaims.unprotect(child.id)
      TaskPlace.drop(child.id)
      TaskPlace.drop(parent.id)
    }).pipe(Effect.orDie),
  )
  yield* isolation.reserve({ taskID: child.id, parentSessionID: parent.id, title: "Task review fixture", agent })
  const started = yield* isolation.start(child.id)
  yield* write(started.record.directory, "probe.txt", "WORKTREE_ONLY_CONTENT\n")
  const settle = () => isolation.settle({ taskID: child.id, attempt: 1 })
  const promptOps: TaskPromptOps = {
    cancel: (id) => prompts.cancel(id),
    resolvePromptParts: (value) => prompts.resolvePromptParts(value),
    prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
  }
  const request: ConnectHub.StartRequest = {
    to: "vectorscope",
    action: "review",
    target: { kind: "task", task: child.id },
    security: false,
    requester: { kind: "agent", sessionID: parent.id, agent: "build" },
    directory: home.directory,
    background: false,
  }
  const asks: string[] = []
  const ask: Tool.Context["ask"] = (input) =>
    Effect.sync(() => {
      asks.push(input.permission)
    })
  const run = (override: Partial<ConnectHub.Call> = {}) => hub.run({ request, call: { ask, promptOps, ...override } })
  return {
    home,
    llm,
    sessions,
    isolation,
    parent,
    child,
    agent,
    workPath,
    settle,
    store,
    request,
    hub,
    run,
    asks,
    promptOps,
  }
})

const report = () =>
  reply()
    .tool("StructuredOutput", {
      summary: "The saved task changes are sound.",
      risk: "low",
      files: [{ path: "probe.txt", note: "Task changed its probe" }],
      findings: [],
    })
    .usage({ input: 100, output: 20 })

live.instance(
  "the actual reviewer reads the task copy, retains the requester lineage and spends from its live run",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const saved = yield* f.settle()
      expect(saved.state).toBe("changed")
      const guard = yield* SpendGuard.Service
      yield* guard.begin(f.parent.id, { usd: 0.5, steps: 20 })
      yield* f.llm.push(reply().tool("read", { filePath: "probe.txt" }).usage({ input: 100, output: 20 }))
      yield* f.llm.push(report())
      const run = yield* f.run()
      expect(run.result?.state, run.result?.summary).toBe("completed")
      expect(run.result?.verdict).toBe("clean")
      expect(run.result?.target).toEqual({ kind: "task", task: f.child.id })
      expect(run.result?.base).toBe(saved.reviewBase ?? saved.seed)
      expect(run.result?.head).toBe(saved.tip)
      expect(run.result?.cached).toBe(false)
      expect(run.result!.sessions.length).toBeGreaterThan(0)
      for (const id of run.result!.sessions) {
        const reviewer = yield* f.sessions.get(id)
        const place = reviewer.parentID ? yield* f.sessions.get(reviewer.parentID) : undefined
        expect(place?.internal).toBe("vectorscope.place")
        expect(place?.parentID).toBe(f.parent.id)
        expect(reviewer.directory).toBe(f.home.directory)
        expect(yield* guard.rootOf(id)).toBe(f.parent.id)
        const parts = (yield* f.sessions.messages({ sessionID: id })).flatMap((message) => message.parts)
        const read = parts.find((part) => part.type === "tool" && part.tool === "read")
        expect(read?.type === "tool" && read.state.status === "completed" ? read.state.output : "").toContain(
          "WORKTREE_ONLY_CONTENT",
        )
        expect(read?.type === "tool" && read.state.status === "completed" ? read.state.output : "").not.toContain(
          "PARENT_ONLY_CONTENT",
        )
      }
      const spend = yield* guard.snapshot(f.parent.id)
      expect(spend?.steps).toBe(2)
      expect(spend!.spentUsd).toBeGreaterThan(0)
      expect((yield* f.store.loaded()).some((ctx) => FileLock.key(ctx.directory) === FileLock.key(f.workPath))).toBe(
        false,
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(f.home.directory, "probe.txt"), "utf8"))).toBe(
        "PARENT_ONLY_CONTENT\n",
      )
      yield* guard.end(f.parent.id)
    }),
  { git: true },
  60_000,
)

live.instance(
  "a full task re-review compares its stored findings and refuses since from another valid task",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.settle()
      const flagged = () =>
        reply().tool("StructuredOutput", {
          summary: "The probe contains the wrong marker.",
          risk: "medium",
          files: [{ path: "probe.txt", note: "Marker rewritten" }],
          findings: [
            {
              path: "probe.txt",
              line: 1,
              severity: "concern",
              category: "bug",
              title: "Wrong probe marker",
              body: "The changed probe no longer holds its expected marker.",
              confidence: 0.9,
            },
          ],
        })
      yield* f.llm.push(flagged())
      const first = yield* f.run()
      expect(first.result?.state, first.result?.summary).toBe("completed")
      expect(first.result?.findings).toHaveLength(1)
      yield* f.llm.push(flagged())
      const second = yield* f.hub.run({
        request: { ...f.request, since: first.id },
        call: { ask: () => Effect.void, promptOps: f.promptOps },
      })
      expect(second.result?.state, second.result?.summary).toBe("completed")
      expect(second.result?.cached).toBe(false)
      expect(second.result?.target).toEqual({ kind: "task", task: f.child.id })
      expect(second.result?.findings.map((finding) => finding.status)).toEqual(["still-open"])

      const other = yield* f.sessions.create({ title: "Another isolated task", parentID: f.parent.id })
      const otherWork = path.join(Global.Path.data, "task-worktree", f.home.project.id, other.id)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* f.store.disposeDirectory(otherWork)
          yield* git(f.home.directory, ["worktree", "remove", "--force", otherWork]).pipe(
            Effect.catchCause(() => Effect.void),
          )
          yield* git(f.home.directory, ["branch", "-D", `vector/subagent/${other.id}`]).pipe(
            Effect.catchCause(() => Effect.void),
          )
          yield* Effect.promise(() =>
            fs.rm(path.join(Global.Path.data, "task-isolation", f.home.project.id, other.id), {
              recursive: true,
              force: true,
            }),
          )
          TaskClaims.unprotect(other.id)
          TaskPlace.drop(other.id)
        }).pipe(Effect.orDie),
      )
      yield* f.isolation.reserve({
        taskID: other.id,
        parentSessionID: f.parent.id,
        title: "Other task",
        agent: f.agent,
      })
      const started = yield* f.isolation.start(other.id)
      yield* write(started.record.directory, "probe.txt", "OTHER_TASK_CONTENT\n")
      yield* f.isolation.settle({ taskID: other.id, attempt: 1 })
      const calls = (yield* f.llm.hits).length
      const refused = yield* f.hub.run({
        request: { ...f.request, target: { kind: "task", task: other.id }, since: first.id },
        call: { ask: () => Effect.die("Cross-task comparison must be refused before consent"), promptOps: f.promptOps },
      })
      expect(refused.result?.state).toBe("refused")
      expect(refused.result?.summary).toContain("cannot be compared")
      expect((yield* f.llm.hits).length).toBe(calls)
    }),
  { git: true },
  60_000,
)

for (const action of ["deny", "ask"] as const) {
  live.instance(
    `an original absolute read ${action} blocks files that exist only in the task worktree before consent`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        yield* write(f.workPath, "private/new.txt", "TASK_PRIVATE_CONTENT\n")
        yield* f.settle()
        yield* f.sessions.setPermission({
          sessionID: f.parent.id,
          permission: [
            {
              permission: "read",
              pattern: path.join(f.home.directory, "private/new.txt").replaceAll("\\", "/"),
              action,
            },
          ],
        })
        const run = yield* f.run()
        expect(run.result?.state).toBe("refused")
        expect(run.result?.refusal).toBe("read-rule")
        expect(f.asks).toEqual([])
        expect(yield* f.llm.hits).toHaveLength(0)
      }),
    { git: true },
    60_000,
  )
}

live.instance(
  "a restricted file appearing after preflight cannot be read by a placed helper",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.settle()
      yield* f.sessions.setPermission({
        sessionID: f.parent.id,
        permission: [
          {
            permission: "read",
            pattern: path.join(f.home.directory, "private/new.txt").replaceAll("\\", "/"),
            action: "ask",
          },
        ],
      })
      yield* f.llm.push(reply().tool("read", { filePath: "private/new.txt" }))
      yield* f.llm.push(report())
      const run = yield* f.run({
        ask: (input) =>
          input.permission === "connect"
            ? write(f.workPath, "private/new.txt", "NEVER_SEND_THIS_SECRET\n")
            : Effect.void,
      })
      expect(run.result?.state).toBe("refused") // The checkout also drifted after its saved review range.
      const hits = yield* f.llm.hits
      expect(hits.length).toBeGreaterThan(0)
      expect(JSON.stringify(hits)).not.toContain("NEVER_SEND_THIS_SECRET")
      const children = yield* f.sessions.children(f.parent.id)
      const place = children.find((session) => session.internal === "vectorscope.place")
      expect(place).toBeDefined()
      const reviewers = yield* f.sessions.children(place!.id)
      const parts = yield* Effect.forEach(reviewers, (session) => f.sessions.messages({ sessionID: session.id }))
      expect(
        parts
          .flat(2)
          .flatMap((message) => message.parts)
          .some((part) => part.type === "tool" && part.tool === "read" && part.state.status === "error"),
      ).toBe(true)
    }),
  { git: true },
  60_000,
)

live.instance(
  "running tasks and tasks from another conversation are refused without model calls",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      expect((yield* f.run()).result?.state).toBe("refused")
      yield* f.settle()
      const other = yield* f.sessions.create({ title: "Other owner" })
      const request = {
        ...f.request,
        requester: { kind: "user", sessionID: other.id },
      } satisfies ConnectHub.StartRequest
      const run = yield* f.hub.run({ request, call: { ask: () => Effect.void } })
      expect(run.result?.state).toBe("refused")
      expect(yield* f.llm.hits).toHaveLength(0)
      expect(f.asks).toEqual([])
    }),
  { git: true },
  60_000,
)

live.instance(
  "canceling during task consent releases the isolation lock before any model starts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.settle()
      const entered = yield* Deferred.make<void>()
      const caller = new AbortController()
      const running = yield* f
        .run({
          abort: caller.signal,
          ask: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      caller.abort()
      const run = yield* Fiber.join(running)
      expect(run.result?.state).toBe("cancelled")
      const saved = yield* f.isolation.review({ taskID: f.child.id, parentSessionID: f.parent.id }, (record) =>
        Effect.succeed(record.tip),
      )
      expect(saved).toBeDefined()
      expect((yield* f.store.loaded()).some((ctx) => FileLock.key(ctx.directory) === FileLock.key(f.workPath))).toBe(
        false,
      )
      expect(yield* f.llm.hits).toHaveLength(0)
    }),
  { git: true },
  60_000,
)

live.instance(
  "canceling after a real reviewer starts joins the helper, disposes its placement and releases the task lock",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.settle()
      yield* f.llm.hang
      const caller = new AbortController()
      const running = yield* f.run({ abort: caller.signal }).pipe(Effect.forkChild)
      yield* f.llm.wait(1)
      expect((yield* f.store.loaded()).some((ctx) => FileLock.key(ctx.directory) === FileLock.key(f.workPath))).toBe(
        true,
      )
      const place = (yield* f.sessions.children(f.parent.id)).find(
        (session) => session.internal === "vectorscope.place",
      )
      expect(place).toBeDefined()
      const reviewers = yield* f.sessions.children(place!.id)
      expect(reviewers.length).toBeGreaterThan(0)
      caller.abort()
      const run = yield* Fiber.join(running)
      expect(run.result?.state).toBe("cancelled")
      const status = yield* SessionStatus.Service
      for (const reviewer of reviewers) expect((yield* status.get(reviewer.id)).type).toBe("idle")
      expect((yield* f.store.loaded()).some((ctx) => FileLock.key(ctx.directory) === FileLock.key(f.workPath))).toBe(
        false,
      )
      expect(
        yield* f.isolation.review({ taskID: f.child.id, parentSessionID: f.parent.id }, () =>
          Effect.succeed("unlocked"),
        ),
      ).toBe("unlocked")
    }),
  { git: true },
  60_000,
)

live.instance(
  "deleting a target during its real review cannot accept the old task result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* f.settle()
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* f.llm.push(report().wait(release.promise))
      const running = yield* f.run().pipe(Effect.forkChild)
      yield* f.llm.wait(1)
      yield* TaskIsolation.enqueueDeleted(f.child)
      release.resolve()
      const run = yield* Fiber.join(running)
      expect(run.result?.state).toBe("refused")
      expect(run.result?.summary).toContain("changed while it was being reviewed")
      expect(run.result?.verdict).toBe("not-reviewed")
      expect(run.result?.cost?.kind).toBe("priced")
      expect(run.result?.cost?.usd).toBeGreaterThan(0)
      expect(run.result?.sendsTo).toBe("provider:lmstudio")
      expect(run.result!.sessions.length).toBeGreaterThan(0)
      expect((yield* f.store.loaded()).some((ctx) => FileLock.key(ctx.directory) === FileLock.key(f.workPath))).toBe(
        false,
      )
    }),
  { git: true },
  60_000,
)

test("absolute authorities with a glob across the launching root are refused instead of widening", () => {
  const result = ConnectPlacement.readDenies({
    rules: [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "read", pattern: "/source/*/private/*", action: "deny" },
    ],
    sources: ["/source/repo"],
    work: ["/tasks/one"],
  })
  expect(result.ok).toBe(false)
})

test("absolute scan aliases do not turn a relative file allow into the default ask", async () => {
  await using directory = await tmpdir()
  await fs.writeFile(path.join(directory.path, "public.txt"), "readable")
  expect(
    await ConnectHub.scan(
      directory.path,
      ["*"],
      [
        { permission: "read", pattern: "*", action: "ask" },
        { permission: "read", pattern: "public.txt", action: "allow" },
      ],
      { prefixes: [directory.path] },
    ),
  ).toEqual({})
})
