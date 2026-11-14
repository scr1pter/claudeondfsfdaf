import { afterEach, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import type { Connect } from "@vectordevai/schema/connect"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Global } from "@vectordevai/core/global"
import { Npm } from "@vectordevai/core/npm"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { ConnectDirectory } from "@/connect/directory"
import { ConnectHub } from "@/connect/hub"
import { ConnectOwner } from "@/connect/owner"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, trustWorkspace, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
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
      ConnectOwner.node,
      Config.node,
      ConnectHub.node,
      SessionPrompt.node,
      Session.node,
      Agent.node,
      Git.node,
      InstanceStore.node,
      SessionStatus.node,
      Permission.node,
      BackgroundJob.node,
      BackgroundJobStore.node,
      CrossSpawnSpawner.node,
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
const write = (directory: string, file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await fs.writeFile(path.join(directory, file), text)
  })
const git = Effect.fn("ConnectDirectoryLiveTest.git")(function* (directory: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd: directory })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.text().trim()
})
const fixture = (read?: Record<string, "allow" | "deny" | "ask">) =>
  Effect.gen(function* () {
    const current = yield* InstanceState.context
    const llm = yield* TestLLMServer
    const config = yield* Config.Service
    const globalFile = path.join(Global.Path.config, "vector.json")
    const original = yield* Effect.promise(() => fs.readFile(globalFile, "utf8").catch(() => undefined))
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (original === undefined) await fs.rm(globalFile, { force: true })
        else await fs.writeFile(globalFile, original)
      }).pipe(Effect.andThen(config.invalidate())),
    )
    // The real service selects its model from owner settings, never the reviewed project's default model.
    yield* write(
      Global.Path.config,
      "vector.json",
      JSON.stringify({ agent: { vectorscope: { model: "lmstudio/test-model" } } }),
    )
    yield* config.invalidate()
    const provider = testProviderConfig(llm.url)
    provider.provider.lmstudio.models["test-model"].cost = { input: 1, output: 1 }
    yield* git(current.directory, ["config", "core.autocrlf", "false"])
    yield* write(
      current.directory,
      "vector.json",
      JSON.stringify({
        ...provider,
        model: "lmstudio/test-model",
        permission: { connect: "allow", connect_model: "ask", ...(read ? { read } : {}) },
      }),
    )
    yield* write(current.directory, "probe.txt", "BASE_CONTENT\n")
    yield* git(current.directory, ["add", "-A"])
    yield* git(current.directory, ["commit", "-qm", "directory review fixture base"])
    const base = yield* git(current.directory, ["rev-parse", "HEAD"])
    yield* write(current.directory, "probe.txt", "SELECTED_WORKSPACE_CONTENT\n")
    yield* Effect.promise(() => trustWorkspace(current.directory))
    const owner = yield* ConnectOwner.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    const background = yield* BackgroundJob.Service
    const jobs = yield* BackgroundJobStore.Service
    const store = yield* InstanceStore.Service
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        fs.rm(
          path.join(
            Global.Path.data,
            "storage",
            ...ConnectDirectory.prefix({ projectID: current.project.id, directory: current.directory }),
          ),
          { recursive: true, force: true },
        ),
      ),
    )
    const pending = (id: string) =>
      pollWithTimeout(
        permission.list().pipe(Effect.map((rows) => rows.find((row) => row.metadata.runID === id))),
        "The actual review model consent did not arrive",
      )
    const ended = (id: string) =>
      pollWithTimeout(
        owner.get(id).pipe(Effect.map((run) => (run.status === "done" ? run : undefined))),
        "The actual directory review did not finish",
        "20 seconds",
      )
    return { current, llm, base, owner, permission, sessions, background, jobs, store, pending, ended }
  })
const reviewInput = (input: Connect.ReviewInput = {}): Connect.DirectoryReviewInput => ({
  requestKey: randomUUID(),
  ...input,
})

const report = () =>
  reply()
    .tool("StructuredOutput", {
      summary: "The selected workspace changes are sound.",
      risk: "low",
      files: [{ path: "probe.txt", note: "The selected workspace probe changed" }],
      findings: [],
    })
    .usage({ input: 100, output: 20 })

const unsupportedGit = (f: Effect.Success<ReturnType<typeof fixture>>) =>
  Effect.gen(function* () {
    const input = reviewInput({ security: false })
    const queued = yield* f.owner.directoryReview(input)
    const done = yield* f.ended(queued.id)
    expect(done.result?.state).toBe("refused")
    expect(done.result?.refusal).toBe("unavailable")
    expect(done.result?.verdict).toBe("not-reviewed")
    expect(done.result?.summary).toContain("Git reads cannot be inspected safely")
    expect(done.result?.sessions).toEqual([])
    expect(yield* f.permission.list()).toEqual([])
    expect(yield* f.llm.inputs).toHaveLength(0)
    expect(yield* f.sessions.list()).toEqual([])
    expect(
      (yield* f.sessions.list({ internal: true })).filter(
        (session) => session.internal?.startsWith("vectorscope.") && session.internal !== "vectorscope.directory",
      ),
    ).toEqual([])
    expect(yield* f.owner.directoryReview(input)).toEqual(done)
    expect(yield* f.llm.inputs).toHaveLength(0)
  })

const retarget = Effect.fn("ConnectDirectoryLiveTest.retarget")(function* (directory: string, other: string) {
  const saved = `${directory}.directory-original`
  const state = { moved: false, linked: false }
  const restore = Effect.promise(async () => {
    if (state.linked) {
      await fs.rm(directory, { recursive: true, force: true })
      state.linked = false
    }
    if (state.moved) {
      await fs.rename(saved, directory)
      state.moved = false
    }
  })
  yield* Effect.addFinalizer(() => restore.pipe(Effect.orDie))
  yield* Effect.promise(async () => {
    await fs.rename(directory, saved)
    state.moved = true
    await fs.symlink(other, directory, process.platform === "win32" ? "junction" : "dir")
    state.linked = true
  })
  return restore
})

live.instance(
  "a stable explicit retry recovers one actual paid review and never makes another provider call",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      if (process.platform !== "linux") return yield* unsupportedGit(f)
      const input = reviewInput({ security: false, background: true })
      yield* f.llm.push(report())
      const original = yield* f.owner.directoryReview(input)
      const ask = yield* f.pending(original.id)
      expect(yield* f.llm.inputs).toHaveLength(0)
      const recovered = yield* f.owner.directoryReview({ ...input, requestKey: input.requestKey.toUpperCase() })
      expect(recovered.id).toBe(original.id)
      expect((yield* f.permission.list()).filter((entry) => entry.metadata.runID === original.id)).toHaveLength(1)
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      const done = yield* f.ended(original.id)
      expect(done.result?.state, done.result?.summary).toBe("completed")
      expect(done.result?.cost?.kind).toBe("priced")
      expect(done.result?.cost?.usd).toBeGreaterThan(0)
      expect(yield* f.owner.directoryReview(input)).toEqual(done)
      expect(yield* f.llm.inputs).toHaveLength(1)
      expect(yield* f.jobs.forParent(ask.sessionID)).toHaveLength(1)
      expect(yield* f.permission.list()).toEqual([])
    }),
  { git: true },
  60_000,
)

live.instance(
  "actual directory review withholds priced HTTP calls until owner approval, reads the selected copy and reloads a sealed result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      if (process.platform !== "linux") return yield* unsupportedGit(f)
      yield* f.llm.push(reply().tool("read", { filePath: "probe.txt" }).usage({ input: 100, output: 20 }))
      yield* f.llm.push(report())
      const queued = yield* f.owner.directoryReview(reviewInput({ security: false }))
      const ask = yield* f.pending(queued.id)
      expect(ask.permission).toBe("connect_model")
      expect(yield* f.llm.inputs).toHaveLength(0)
      expect(queued.request.requester.sessionID).toBeUndefined()
      expect(yield* f.sessions.messages({ sessionID: ask.sessionID })).toEqual([])
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      const done = yield* f.ended(queued.id)
      expect(done.result?.state, done.result?.summary).toBe("completed")
      expect(done.result?.verdict).toBe("clean")
      expect(done.result?.cost?.kind).toBe("priced")
      expect(done.result?.cost?.usd).toBeGreaterThan(0)
      expect(done.request.directory).toBe(f.current.directory)
      expect(done.result?.base).toBe(f.base)
      if (!done.result || done.result.sessions.length === 0) throw new Error("The actual review created no helpers")
      for (const id of done.result.sessions) {
        const helper = yield* f.sessions.get(id)
        expect(helper.parentID).toBe(ask.sessionID)
        expect(helper.internal).toStartWith("vectorscope.")
        const parts = (yield* f.sessions.messages({ sessionID: id })).flatMap((message) => message.parts)
        const read = parts.find((part) => part.type === "tool" && part.tool === "read")
        expect(read?.type === "tool" && read.state.status === "completed" ? read.state.output : "").toContain(
          "SELECTED_WORKSPACE_CONTENT",
        )
      }
      expect(yield* f.sessions.list()).toEqual([])
      expect(yield* f.sessions.messages({ sessionID: ask.sessionID })).toEqual([])
      expect((yield* f.background.wait({ id: done.id, timeout: 5_000 })).timedOut).toBe(false)
      const next = yield* f.store.reload({
        directory: f.current.directory,
        worktree: f.current.worktree,
        project: f.current.project,
      })
      expect(yield* f.owner.get(done.id).pipe(Effect.provideService(InstanceRef, next))).toEqual(done)
      expect(yield* f.llm.inputs).toHaveLength(2)
    }),
  { git: true },
  60_000,
)

live.instance(
  "canceling a pending actual directory review withdraws consent without a provider call",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      if (process.platform !== "linux") return yield* unsupportedGit(f)
      const queued = yield* f.owner.directoryReview(reviewInput({ security: false }))
      const ask = yield* f.pending(queued.id)
      expect(yield* f.llm.inputs).toHaveLength(0)
      expect(yield* f.owner.cancel(queued.id)).toBe(true)
      expect((yield* f.ended(queued.id)).result?.state).toBe("cancelled")
      expect(yield* f.permission.list()).toEqual([])
      expect(yield* f.sessions.children(ask.sessionID)).toEqual([])
      expect(yield* f.llm.inputs).toHaveLength(0)
    }),
  { git: true },
  60_000,
)

live.instance(
  "canceling after the actual directory model starts joins every hidden reviewer",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      if (process.platform !== "linux") return yield* unsupportedGit(f)
      yield* f.llm.hang
      const queued = yield* f.owner.directoryReview(reviewInput({ security: false }))
      const ask = yield* f.pending(queued.id)
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      yield* f.llm.wait(1)
      const children = yield* f.sessions.children(ask.sessionID)
      expect(children.length).toBeGreaterThan(0)
      expect(yield* f.owner.cancel(queued.id)).toBe(true)
      expect((yield* f.ended(queued.id)).result?.state).toBe("cancelled")
      const status = yield* SessionStatus.Service
      for (const child of children) expect((yield* status.get(child.id)).type).toBe("idle")
      expect(yield* f.permission.list()).toEqual([])
      expect((yield* f.background.wait({ id: queued.id, timeout: 5_000 })).timedOut).toBe(false)
      const next = yield* f.store.reload({
        directory: f.current.directory,
        worktree: f.current.worktree,
        project: f.current.project,
      })
      expect((yield* f.owner.get(queued.id).pipe(Effect.provideService(InstanceRef, next))).result?.state).toBe(
        "cancelled",
      )
      expect(yield* f.llm.inputs).toHaveLength(1)
    }),
  { git: true },
  60_000,
)

live.instance(
  "replacing the selected canonical directory during consent cannot authorize another checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      if (process.platform !== "linux") return yield* unsupportedGit(f)
      const other = yield* tmpdirScoped()
      yield* write(other, "probe.txt", "NEVER_SEND_RETARGETED_WORKSPACE_CANARY\n")
      yield* f.llm.push(report())
      const queued = yield* f.owner.directoryReview(reviewInput({ security: false }))
      const ask = yield* f.pending(queued.id)
      const restore = yield* retarget(f.current.directory, other)
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      expect((yield* f.background.wait({ id: queued.id, timeout: 5_000 })).timedOut).toBe(false)
      expect(yield* f.llm.inputs).toHaveLength(0)
      expect(JSON.stringify(yield* f.llm.hits)).not.toContain("NEVER_SEND_RETARGETED_WORKSPACE_CANARY")
      yield* restore
      expect((yield* f.owner.get(queued.id)).result?.verdict).not.toBe("clean")
      expect(yield* f.permission.list()).toEqual([])
    }),
  { git: true },
  60_000,
)

live.instance(
  "the real provider admission policy blocks a replaced directory between a read and the next paid step",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      if (process.platform !== "linux") return yield* unsupportedGit(f)
      const other = yield* tmpdirScoped()
      yield* write(other, "probe.txt", "NEVER_SEND_MID_REVIEW_CANARY\n")
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      yield* f.llm.push(
        reply().tool("read", { filePath: "probe.txt" }).usage({ input: 100, output: 20 }).wait(release.promise),
      )
      yield* f.llm.push(report())
      const queued = yield* f.owner.directoryReview(reviewInput({ security: false }))
      const ask = yield* f.pending(queued.id)
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      yield* f.llm.wait(1)
      const restore = yield* retarget(f.current.directory, other)
      release.resolve()
      expect((yield* f.background.wait({ id: queued.id, timeout: 10_000 })).timedOut).toBe(false)
      expect(yield* f.llm.inputs).toHaveLength(1)
      expect(JSON.stringify(yield* f.llm.hits)).not.toContain("NEVER_SEND_MID_REVIEW_CANARY")
      yield* restore
      const done = yield* f.owner.get(queued.id)
      expect(done.result?.verdict).not.toBe("clean")
      expect(done.result?.cost?.kind).toBe("priced")
      expect(done.result?.cost?.usd).toBeGreaterThan(0)
      const status = yield* SessionStatus.Service
      for (const child of yield* f.sessions.children(ask.sessionID))
        expect((yield* status.get(child.id)).type).toBe("idle")
    }),
  { git: true },
  60_000,
)

live.instance(
  "a restricted file created during directory model consent is refused before any provider call",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ "*": "allow", "private/*": "deny" })
      if (process.platform !== "linux") return yield* unsupportedGit(f)
      const queued = yield* f.owner.directoryReview(reviewInput({ security: false }))
      const ask = yield* f.pending(queued.id)
      yield* write(f.current.directory, "private/new.txt", "NEVER_SEND_THIS_DIRECTORY_SECRET\n")
      yield* f.permission.reply({ requestID: ask.id, reply: "once" })
      const done = yield* f.ended(queued.id)
      expect(done.result?.state).toBe("refused")
      expect(done.result?.refusal).toBe("read-rule")
      expect(yield* f.llm.inputs).toHaveLength(0)
      expect(JSON.stringify(yield* f.llm.hits)).not.toContain("NEVER_SEND_THIS_DIRECTORY_SECRET")
    }),
  { git: true },
  60_000,
)
