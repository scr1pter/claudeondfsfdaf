import { afterEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
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
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { SessionRunState } from "@/session/run-state"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import { TaskClaims } from "@/task/claims"
import { TaskIsolation } from "@/task/isolation"
import { TaskPlace } from "@/task/place"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import { ToolRegistry } from "@/tool/registry"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// An agent's merge goes through the same edit ask as edit and write, so a prompt file it changes asks prompt_source
// (F.4 merge step 4). This drives the real SessionTools chokepoint with a real isolated task in both modes; no model runs.
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
      Brain.node,
      EventV2Bridge.node,
      MCP.node,
      Permission.node,
      Plugin.node,
      Provider.node,
      ToolRegistry.node,
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
const provider = {
  "local-test": {
    npm: "@ai-sdk/openai-compatible",
    name: "Local test",
    options: { baseURL: "http://127.0.0.1:1/v1" },
    models: { model: { name: "Test", limit: { context: 16_384, output: 1_024 } } },
  },
}

for (const git of [true, false])
  it.instance(
    `${git ? "a Git" : "a copy"} agent merge of a loaded config file asks prompt_source after its edit ask`,
    () =>
      Effect.gen(function* () {
        const home = yield* InstanceState.context
        const sessions = yield* Session.Service
        const isolation = yield* TaskIsolation.Service
        const agents = yield* Agent.Service
        const registry = yield* ToolRegistry.Service
        const providers = yield* Provider.Service
        const permissions = yield* Permission.Service
        const service = yield* Git.Service
        const store = yield* InstanceStore.Service
        if (git) {
          yield* service.run(["config", "core.autocrlf", "false"], { cwd: home.directory })
          yield* service.run(["add", "vector.json"], { cwd: home.directory })
          yield* service.run(["commit", "-m", "config"], { cwd: home.directory })
        }
        const config = path.join(home.directory, "vector.json")
        const original = yield* Effect.promise(() => fs.readFile(config, "utf8"))
        const parent = yield* sessions.create({ title: "Merge ask" })
        const child = yield* sessions.create({ parentID: parent.id })
        const work = path.join(Global.Path.data, "task-worktree", home.project.id, child.id)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* store.disposeDirectory(work)
            yield* service.run(["worktree", "remove", "--force", work], { cwd: home.directory })
            yield* service.run(["branch", "-D", `vector/subagent/${child.id}`], { cwd: home.directory })
            yield* Effect.promise(async () => {
              await fs.rm(work, { recursive: true, force: true })
              await fs.rm(path.join(Global.Path.data, "task-isolation", home.project.id, child.id), {
                recursive: true,
                force: true,
              })
            })
            TaskClaims.unprotect(child.id)
            TaskPlace.drop(child.id)
          }).pipe(Effect.orDie),
        )
        const general = yield* agents.get("general")
        yield* isolation.reserve({ taskID: child.id, parentSessionID: parent.id, title: "Config", agent: general })
        expect((yield* isolation.start(child.id)).record.mode).toBe(git ? "worktree" : "copy")
        // The child adds an instruction file to the config the parent's prompts are built from.
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(work, "vector.json"),
            JSON.stringify({ ...JSON.parse(original), instructions: ["x.md"] }),
          ),
        )
        expect((yield* isolation.settle({ taskID: child.id, attempt: 1 })).state).toBe("changed")

        const build = yield* agents.get("build")
        if (!build) throw new Error("Build agent unavailable")
        const message: SessionV1.Assistant = {
          id: MessageID.ascending(),
          sessionID: parent.id,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          cost: 0,
          path: { cwd: home.directory, root: home.worktree },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          providerID: ref.providerID,
          modelID: ref.modelID,
          time: { created: Date.now() },
        }
        // The parent agent's task_manage merge, as the tool builds it from its context.
        const probe: Tool.Def = {
          id: "probe",
          parameters: Schema.Struct({}),
          description: "Probe",
          execute: (_args, ctx) =>
            isolation
              .merge({
                taskID: child.id,
                by: {
                  kind: "agent",
                  sessionID: ctx.sessionID,
                  ask: ctx.ask,
                  assertWritable: (input) => ctx.assertWritable!(input),
                  assertExternalDirectory: (file) => assertExternalDirectoryEffect(ctx, file),
                },
              })
              .pipe(Effect.as({ title: "Merged", output: "Merged", metadata: {} }), Effect.orDie),
        }
        const tools = yield* SessionTools.resolve({
          // The edit rules allow every edit; a prompt file still asks.
          agent: { ...build, permission: [...build.permission, { permission: "edit", pattern: "*", action: "allow" }] },
          model: yield* providers.getModel(ref.providerID, ref.modelID),
          session: parent,
          messages: [],
          invokedAgents: [],
          processor: { message, updateToolCall: () => Effect.succeed(undefined), completeToolCall: () => Effect.void },
          promptOps: {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.succeed([]),
            prompt: () => Effect.die("Unexpected model request"),
          },
        }).pipe(Effect.provideService(ToolRegistry.Service, { ...registry, tools: () => Effect.succeed([probe]) }))
        const settled = { done: false }
        const running = Promise.resolve(
          tools.probe.execute!({}, { toolCallId: "probe", messages: [], abortSignal: new AbortController().signal }),
        ).finally(() => {
          settled.done = true
        })
        running.catch(() => undefined)
        // Either the prompt_source ask arrives, or the merge finishes without one.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const asked = (yield* permissions.list()).some((item) => item.permission === PermissionPolicy.PROMPT_SOURCE)
            return asked || settled.done ? true : undefined
          }),
          "the merge neither asked prompt_source nor finished",
          "10 seconds",
        )
        const request = (yield* permissions.list()).find((item) => item.permission === PermissionPolicy.PROMPT_SOURCE)
        expect(request).toBeDefined()
        expect(request!.patterns.map((pattern) => path.resolve(home.worktree, pattern))).toEqual([config])
        yield* permissions.reply({ requestID: request!.id, reply: "reject" })
        expect(
          yield* Effect.promise(() =>
            running.then(
              () => "merged",
              () => "refused",
            ),
          ),
        ).toBe("refused")
        expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).toBe(original)
        expect((yield* isolation.get(child.id)).state).toBe("changed")
      }),
    { git, trusted: true, config: { provider } },
  )
