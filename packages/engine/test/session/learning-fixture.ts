import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import { afterAll } from "bun:test"
import { Effect, Layer } from "effect"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import type { RunBudget } from "@vectordevai/schema/run-budget"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { Global } from "@vectordevai/core/global"
import { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { Shell } from "@vectordevai/core/shell"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { FSUtil } from "@vectordevai/core/fs-util"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionArchive } from "@vectordevai/core/share/archive"
import { ProjectV2 } from "@vectordevai/core/project"
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
import { SessionWorkflow } from "../../src/session/workflow"
import { SessionSkillLearn } from "../../src/session/skill-learn"
import { Skill } from "../../src/skill"
import { LearnedSkill } from "../../src/skill/learned"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// The session runtime end to end for learned skills and workflow insights, against the fake LLM server with no paid
// model call: the layers the learning tests share, a provider whose model is the fake server's, a trusted workspace
// whose `bun typecheck` passes once `src/fixed.ts` exists, and helpers to read brain.db.

// Memory lives in the user's config folder, so these tests get one of their own rather than the shared one.
const config = mkdtempSync(path.join(os.tmpdir(), "vector-learning-"))
afterAll(() => rmSync(config, { recursive: true, force: true }))

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.mock(MCP.Service, {
  status: () => Effect.succeed({}),
  clients: () => Effect.succeed({}),
  instructions: () => Effect.succeed([]),
  tools: () => Effect.succeed({}),
  cloudTools: () => Effect.succeed({}),
  prompts: () => Effect.succeed({}),
  resources: () => Effect.succeed({}),
  resourceTemplates: () => Effect.succeed({}),
})

const lsp = Layer.mock(LSP.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  hasClients: () => Effect.succeed(false),
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
})

const root = LayerNode.group([
  SessionPrompt.node,
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
  SpendGuard.node,
  Auth.node,
  Brain.node,
  BrainDatabase.node,
  BrainKnowledge.node,
  BrainSkill.node,
  BrainWorkflow.node,
  LearnedSkill.node,
  SessionWorkflow.node,
  SessionSkillLearn.node,
  FreeModelGuests.node,
  SessionArchive.node,
  ProjectV2.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

/** The engine, with the runtime flags a test needs (`pure` for `--pure`). */
export function engine(flags: Partial<RuntimeFlags.Info> = {}) {
  return testEffect(
    LayerNode.compile(root, [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, ...flags })],
      [Global.node, Global.layerWith({ config })],
    ]),
  )
}

export const ref = { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") }

export function providerConfig(url: string, model: Record<string, unknown> = {}): Partial<ConfigV1.Info> {
  return {
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
            ...model,
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
}

/** The workspace: a trusted vector.json naming the fake model, and a check that passes once `src/fixed.ts` exists. */
export const setup = Effect.fn("learning.setup")(function* (
  input: {
    readonly config?: Partial<ConfigV1.Info>
    readonly model?: Record<string, unknown>
    readonly trust?: boolean
  } = {},
) {
  const dir = (yield* TestInstance).directory
  const llm = yield* TestLLMServer
  const fs = yield* FSUtil.Service
  const file = path.join(dir, "vector.json")
  // Keep the same regular-file check on Windows without requiring a Unix `test` executable on PATH.
  const check = (file: string) =>
    `bun -e "process.exit(require('node:fs').statSync('${file}', {throwIfNoEntry:false})?.isFile() ? 0 : 1)"`
  yield* fs.writeWithDirs(file, JSON.stringify({ ...providerConfig(llm.url, input.model), ...input.config }))
  yield* fs.writeWithDirs(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "learning",
      scripts: {
        typecheck: check("src/fixed.ts"),
        lint: check("src/linted.ts"),
        "test:unit": check("src/tested.ts"),
        verify: check("src/verified.ts"),
        "build:release": check("src/released.ts"),
      },
    }),
  )
  yield* fs.writeWithDirs(path.join(dir, "src", "app.ts"), "export const app = 1\n")
  if (input.trust !== false) {
    const snapshot = yield* Effect.promise(() => WorkspaceTrust.snapshot(dir, [file]))
    yield* Effect.promise(() => WorkspaceTrust.approve(Global.Path.state, snapshot))
  }
  // An untrusted repository's own settings are not applied, so the model comes from the user's side instead.
  if (input.trust === false) {
    const before = process.env.VECTOR_CONFIG_CONTENT
    process.env.VECTOR_CONFIG_CONTENT = JSON.stringify(providerConfig(llm.url, input.model))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (before === undefined) delete process.env.VECTOR_CONFIG_CONTENT
        else process.env.VECTOR_CONFIG_CONTENT = before
      }),
    )
  }
  const place = yield* (yield* Instruction.Service).place()
  return { dir, llm, place }
})

/** A root session that may run everything without asking. */
export const chat = Effect.fn("learning.chat")(function* () {
  const sessions = yield* Session.Service
  return (yield* sessions.create({
    title: "Learning",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })).id
})

/** One prompt to the build agent. */
export const send = Effect.fn("learning.send")(function* (
  sessionID: Session.Info["id"],
  text: string,
  options: {
    readonly size?: "light" | "standard" | "thorough"
    readonly variant?: string
    readonly budget?: RunBudget.Info
  } = {},
) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt.prompt({
    sessionID,
    agent: "build",
    model: { ...ref, ...(options.variant ? { variant: options.variant } : {}) },
    ...(options.size ? { size: options.size } : {}),
    ...(options.budget ? { budget: options.budget } : {}),
    parts: [{ type: "text", text }],
  })
})

/**
 * The check the fake model runs by default, as the agent would type it in the shell the bash tool uses. A POSIX shell
 * keeps the `CI=1` prefix, so a draft shows the command with its env as typed. PowerShell and cmd, Vector's default
 * shells on Windows, read `CI=1` as a command name and cannot run that prefix, so there the check is plain.
 */
export const CHECK = Shell.posix(Shell.acceptable()) ? "CI=1 bun typecheck" : "bun typecheck"

/**
 * The fake model's turn for a run whose check fails, the agent fixes it, and the check passes: the check, a read, a
 * helper command, the fix and the check again. `load` first loads that learned skill; `helper` may be a command whose
 * output is not this computer's.
 */
export const recover = Effect.fn("learning.recover")(function* (
  dir: string,
  input: {
    readonly check?: string
    readonly fix?: string
    readonly read?: string
    readonly helper?: string
    readonly load?: string
  } = {},
) {
  const llm = yield* TestLLMServer
  const check = input.check ?? CHECK
  if (input.load) yield* llm.tool("skill", { name: input.load })
  yield* llm.tool("bash", { command: check, description: "Run the check" })
  yield* llm.tool("read", { filePath: path.join(dir, input.read ?? "src/app.ts") })
  yield* llm.tool("bash", { command: input.helper ?? "git status --short", description: "Look around" })
  yield* llm.tool("write", {
    filePath: path.join(dir, input.fix ?? "src/fixed.ts"),
    content: "export const fixed = true\n",
  })
  yield* llm.tool("bash", { command: check, description: "Run the check again" })
  yield* llm.text("Fixed: the check passes now.")
})

/** The background work a finished run left (drafting, observing), done or cut off after a few seconds. */
export const settle = Effect.fn("learning.settle")(function* () {
  yield* (yield* SessionPrompt.Service).awaitTitles()
})

/** Polls until `check` holds: drafting and observing run in the background once a run is over. */
export const until = <A, E, R>(effect: Effect.Effect<A, E, R>, check: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = yield* effect
      if (check(value)) return value
      yield* Effect.sleep(50)
    }
    return yield* effect
  })

/** Every learned skill entry of the workspace's repository, whatever its status. */
export const learned = Effect.fn("learning.learned")(function* (place: Brain.Place) {
  return yield* (yield* BrainSkill.Service).list(place, "all")
})
