import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { Brain } from "@vectordevai/core/brain/brain"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { ModelV2 } from "@vectordevai/core/model"
import { Npm } from "@vectordevai/core/npm"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionAudience } from "@vectordevai/core/session/audience"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionTools } from "@/session/tools"
import { TaskClaims } from "@/task/claims"
import { TaskIsolation } from "@/task/isolation"
import { TaskManager } from "@/task/manager"
import { TaskPlace } from "@/task/place"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// An isolated helper's terminals live in its checkout's location services, the ones the registry's terminal tool
// opens them in, which core keeps for an hour after their last use. Saving the checkout closes them first, and waits
// for their programs, so none goes on writing in a checkout being saved or retired (handoff 7.3). Real Git, instances,
// sessions and terminals; no model. Terminals run /bin/sh and do not start on Windows in tests (terminal.test.ts).
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      TaskIsolation.node,
      Worktree.node,
      InstanceStore.node,
      Session.node,
      SessionRunState.node,
      BackgroundJob.node,
      Git.node,
      Agent.node,
      Config.node,
      CrossSpawnSpawner.node,
      SessionAudience.node,
      Database.node,
      ToolRegistry.node,
      Permission.node,
      Plugin.node,
      Provider.node,
      MCP.node,
      Brain.node,
      EventV2Bridge.node,
      Truncate.node,
    ]),
    [
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
      [Npm.node, NpmTest.noop],
    ],
  ),
)
// The same, with the task manager, for Stop including helpers (5.D.1).
const withManager = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      TaskManager.node,
      TaskIsolation.node,
      Worktree.node,
      InstanceStore.node,
      Session.node,
      SessionRunState.node,
      BackgroundJob.node,
      Git.node,
      Agent.node,
      Config.node,
      CrossSpawnSpawner.node,
      SessionAudience.node,
      Database.node,
      ToolRegistry.node,
      Permission.node,
      Plugin.node,
      Provider.node,
      MCP.node,
      Brain.node,
      EventV2Bridge.node,
      Truncate.node,
    ]),
    [
      [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
      [Npm.node, NpmTest.noop],
    ],
  ),
)
afterEach(() => disposeAllInstances())

const ref = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("model") }
const options = {
  git: true,
  trusted: true,
  config: {
    provider: {
      "local-test": {
        npm: "@ai-sdk/openai-compatible",
        name: "Local test",
        options: { baseURL: "http://127.0.0.1:1/v1" },
        models: { model: { name: "Test", limit: { context: 16_384, output: 1_024 } } },
      },
    },
  },
}

type Output = { output: string; metadata: { id?: string; matched?: string } }

// The terminal tool as SessionTools gives it to one session working in `instance`, with every ask allowed.
const terminal = Effect.fn("IsolationTerminalTest.terminal")(function* (
  session: Session.Info,
  instance: InstanceContext,
) {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const permission = yield* Permission.Service
  const model = yield* provider.getModel(ref.providerID, ref.modelID)
  const agent = yield* agents.get("build")
  if (!agent) throw new Error("Build agent unavailable")
  const message: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: MessageID.ascending(),
    agent: "build",
    mode: "build",
    cost: 0,
    path: { cwd: "/", root: "/" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: ref.providerID,
    modelID: ref.modelID,
    time: { created: Date.now() },
  }
  const tools = (yield* registry.all()).filter((item) => item.id === "terminal")
  const resolved = yield* SessionTools.resolve({
    agent,
    model,
    session,
    messages: [],
    invokedAgents: [],
    processor: { message, updateToolCall: () => Effect.succeed(undefined), completeToolCall: () => Effect.void },
    promptOps: {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.die("Unexpected model request"),
    },
  }).pipe(
    Effect.provideService(ToolRegistry.Service, { ...registry, tools: () => Effect.succeed(tools) }),
    Effect.provideService(Permission.Service, { ...permission, ask: () => Effect.succeed(undefined) }),
    // As TaskPlace routes an isolated helper's calls: its tools run in the checkout's instance.
    Effect.provideService(InstanceRef, instance),
  )
  return (args: Record<string, unknown>) =>
    Effect.promise(
      async () =>
        resolved.terminal.execute!(args, {
          toolCallId: `terminal-${crypto.randomUUID()}`,
          messages: [],
          abortSignal: new AbortController().signal,
        }) as Promise<Output>,
    )
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

// The program's pid, as the open's result shows it.
const shown = (opened: Output) => Number(/\(pid (\d+)\)/.exec(opened.output)?.[1]) || undefined
const pid = (opened: Output) => {
  const found = shown(opened)
  if (!found) throw new Error(`no pid in ${opened.output}`)
  return found
}

// Kills a counter and its process group if it still runs. A result with no pid has nothing to kill, and a program that
// ends between the probe and the kill needs none.
const stop = (opened: Output) => {
  const found = shown(opened)
  if (!found || !alive(found)) return
  try {
    process.kill(-found, "SIGKILL")
  } catch {}
}

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
// How far a counter has counted: 0 before its first write.
const count = (file: string) =>
  Effect.promise(() =>
    fs.readFile(file, "utf8").then(
      (text) => Number(text) || 0,
      () => 0,
    ),
  )

// A program that counts into a file in its folder every 50 ms, the second one deaf to the close's hangup and terminate.
// Replace each sample atomically: a reader must not mistake echo's truncate-before-write window for a stopped counter.
const LOOP = 'i=0; while :; do i=$((i+1)); echo "$i" > %s.next; mv %s.next %s; sleep 0.05; done'
const counter = (file: string, deaf = false) => ({
  action: "open",
  command: "/bin/sh",
  args: ["-c", `${deaf ? "trap '' HUP TERM; " : ""}${LOOP.replaceAll("%s", file)}`],
})

if (process.platform !== "win32")
  describe("isolated checkout terminals", () => {
    it.instance(
      "saving an isolated helper's checkout closes its terminals and waits for their programs; the parent's stay",
      () =>
        Effect.gen(function* () {
          const home = yield* InstanceState.context
          const git = yield* Git.Service
          const sessions = yield* Session.Service
          const isolation = yield* TaskIsolation.Service
          const agents = yield* Agent.Service
          const done = yield* git.run(["config", "core.autocrlf", "false"], { cwd: home.directory })
          expect(done.exitCode).toBe(0)
          const parent = yield* sessions.create({})
          const child = yield* sessions.create({ parentID: parent.id })
          const agent = yield* agents.get("general")
          if (!agent) throw new Error("General agent unavailable")
          const workPath = path.join(Global.Path.data, "task-worktree", home.project.id, child.id)
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const store = yield* InstanceStore.Service
              yield* store.disposeDirectory(workPath)
              yield* git.run(["worktree", "remove", "--force", workPath], { cwd: home.directory })
              yield* git.run(["branch", "-D", `vector/subagent/${child.id}`], { cwd: home.directory })
              yield* Effect.promise(async () => {
                await fs.rm(workPath, { recursive: true, force: true })
                await fs.rm(path.join(Global.Path.data, "task-isolation", home.project.id, child.id), {
                  recursive: true,
                  force: true,
                })
              })
              TaskClaims.unprotect(child.id)
              TaskPlace.drop(child.id)
              TaskPlace.drop(parent.id)
            }).pipe(Effect.orDie),
          )
          yield* isolation.reserve({ taskID: child.id, parentSessionID: parent.id, title: "Count", agent })
          const started = yield* isolation.start(child.id)
          expect(started.work.directory).toBe(workPath)

          // A failing run must not leave a counter running after the test: the deaf one ignores the hangup the terminal
          // service's own teardown sends. Each open is recorded as it returns, and this finalizer, added before the
          // first, kills whichever still runs.
          const opened: Output[] = []
          yield* Effect.addFinalizer(() => Effect.sync(() => opened.forEach(stop)))
          const track = (result: Output) => Effect.sync(() => void opened.push(result))

          // The helper's two counters in its checkout, and the parent's own at home.
          const helper = yield* terminal(child, started.work)
          const plain = yield* helper(counter("plain.txt")).pipe(Effect.tap(track))
          const deaf = yield* helper(counter("deaf.txt", true)).pipe(Effect.tap(track))
          const own = yield* terminal(parent, home)
          const kept = yield* own(counter("parent.txt")).pipe(Effect.tap(track))
          // Each has counted a few times before the save.
          for (const file of ["plain.txt", "deaf.txt"])
            for (let poll = 0; poll < 400 && (yield* count(path.join(workPath, file))) < 3; poll++)
              yield* Effect.sleep("25 millis")
          for (const file of ["plain.txt", "deaf.txt"])
            expect(yield* count(path.join(workPath, file))).toBeGreaterThanOrEqual(3)
          for (const opened of [plain, deaf, kept]) expect(alive(pid(opened))).toBe(true)

          const saved = yield* isolation.settle({ taskID: child.id, attempt: 1 })
          expect(saved.state).toBe("changed")
          // Both of the helper's programs ended before the save returned, the deaf one too; the parent's runs on.
          expect(alive(pid(plain))).toBe(false)
          expect(alive(pid(deaf))).toBe(false)
          expect(alive(pid(kept))).toBe(true)
          // Nothing writes in the checkout after the save, and the save holds what the counters last wrote.
          const after = {
            plain: yield* read(path.join(workPath, "plain.txt")),
            deaf: yield* read(path.join(workPath, "deaf.txt")),
          }
          yield* Effect.sleep("400 millis")
          expect(yield* read(path.join(workPath, "plain.txt"))).toBe(after.plain)
          expect(yield* read(path.join(workPath, "deaf.txt"))).toBe(after.deaf)
          for (const [file, text] of Object.entries(after)) {
            const shown = yield* git.run(["show", `${saved.tip}:${file}.txt`], { cwd: workPath })
            expect(shown.text()).toBe(text)
          }
          // The checkout's terminals are gone from its location; the parent's is still listed at home.
          expect((yield* helper({ action: "list" })).output).toBe("No terminals here. Open one with action open.")
          expect((yield* own({ action: "list" })).output).toContain(kept.metadata.id!)
          yield* own({ action: "close", id: kept.metadata.id })
        }),
      options,
    )

    withManager.instance(
      "Stop including helpers closes the terminals the conversation's helpers opened; the main agent's and another conversation's stay",
      () =>
        Effect.gen(function* () {
          const home = yield* InstanceState.context
          const sessions = yield* Session.Service
          const manager = yield* TaskManager.Service
          const parent = yield* sessions.create({})
          // A helper that already finished, and its own subagent: their programs outlive them in the home folder.
          const record = (parentSessionID: string) => ({
            subagent: {
              kind: "subagent",
              custom: false,
              agent: "general",
              title: "Watch the build",
              parentSessionID,
              parentMessageID: MessageID.ascending(),
              model: ref,
              background: true,
              status: "completed",
              startedAt: Date.now(),
              completedAt: Date.now(),
              attempt: 1,
            },
          })
          const child = yield* sessions.create({ parentID: parent.id, metadata: record(parent.id) })
          const grandchild = yield* sessions.create({ parentID: child.id, metadata: record(child.id) })
          const stranger = yield* sessions.create({})

          const opened: Output[] = []
          yield* Effect.addFinalizer(() => Effect.sync(() => opened.forEach(stop)))
          const track = (result: Output) => Effect.sync(() => void opened.push(result))
          const helper = yield* (yield* terminal(child, home))(counter("helper.txt", true)).pipe(Effect.tap(track))
          const nested = yield* (yield* terminal(grandchild, home))(counter("nested.txt")).pipe(Effect.tap(track))
          const own = yield* terminal(parent, home)
          const kept = yield* own(counter("parent.txt")).pipe(Effect.tap(track))
          const other = yield* terminal(stranger, home)
          const theirs = yield* other(counter("other.txt")).pipe(Effect.tap(track))
          for (const file of ["helper.txt", "nested.txt", "parent.txt", "other.txt"])
            for (let poll = 0; poll < 400 && (yield* count(path.join(home.directory, file))) < 1; poll++)
              yield* Effect.sleep("25 millis")
          for (const program of [helper, nested, kept, theirs]) expect(alive(pid(program))).toBe(true)

          yield* manager.interrupt(
            { sessionID: parent.id, helpers: true },
            {
              cancel: () => Effect.void,
              resolvePromptParts: () => Effect.succeed([]),
              prompt: () => Effect.die("Unexpected model request"),
            },
          )
          // The helpers' programs ended before the stop returned, the one deaf to the hangup too.
          expect(alive(pid(helper))).toBe(false)
          expect(alive(pid(nested))).toBe(false)
          expect(alive(pid(kept))).toBe(true)
          expect(alive(pid(theirs))).toBe(true)
          const listed = (yield* own({ action: "list" })).output
          expect(listed).toContain(kept.metadata.id!)
          expect(listed).toContain(theirs.metadata.id!)
          expect(listed).not.toContain(helper.metadata.id!)
          expect(listed).not.toContain(nested.metadata.id!)
          yield* own({ action: "close", id: kept.metadata.id })
          yield* own({ action: "close", id: theirs.metadata.id })
        }),
      options,
    )
  })
