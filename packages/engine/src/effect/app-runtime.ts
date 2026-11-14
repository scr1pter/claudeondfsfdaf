import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import { registerRuntimeCleanup } from "./runtime-cleanup"
import * as Observability from "@vectordevai/core/observability"

import { FSUtil } from "@vectordevai/core/fs-util"
import { Database } from "@vectordevai/core/database/database"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { SessionDistill } from "@/session/distill"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { Format } from "@/format"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { Npm } from "@vectordevai/core/npm"
import { memoMap } from "@vectordevai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { AppNodeBuilderV1 } from "./app-node-builder-v1"
import { SessionProjector } from "@vectordevai/core/session/projector"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainEmbed } from "@vectordevai/core/brain/embed"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { BrainWorkflow } from "@vectordevai/core/brain/workflow"
import { LearnedSkill } from "@/skill/learned"
import { TaskNotify } from "@/task/notify"
import { TaskLimits } from "@/task/limits"
import { TaskRecovery } from "@/task/recovery"
import { TaskAttention } from "@/task/attention"
import { TaskSignals } from "@/task/signals"
import { ResearchStore } from "@vectordevai/core/research/store"

export const AppLayer = AppNodeBuilderV1.build(
  LayerNode.group([
    Npm.node,
    FSUtil.node,
    Database.node,
    Auth.node,
    Config.node,
    Git.node,
    Storage.node,
    Snapshot.node,
    Plugin.node,
    ModelCatalog.node,
    Provider.node,
    ProviderAuth.node,
    Agent.node,
    Skill.node,
    Discovery.node,
    Question.node,
    Permission.node,
    Todo.node,
    Session.node,
    SessionProjector.node,
    SessionStatus.node,
    BackgroundJob.node,
    TaskNotify.node,
    TaskLimits.node,
    TaskRecovery.node,
    TaskAttention.node,
    TaskSignals.node,
    RuntimeFlags.node,
    EventV2Bridge.node,
    SessionRunState.node,
    SessionProcessor.node,
    SessionCompaction.node,
    SessionRevert.node,
    SessionSummary.node,
    SessionPrompt.node,
    SessionDistill.node,
    SpendGuard.node,
    Brain.node,
    BrainKnowledge.node,
    BrainSkill.node,
    BrainWorkflow.node,
    LearnedSkill.node,
    BrainEmbed.node,
    // `vector memory erase` forgets research with the memory it erases.
    ResearchStore.node,
    Instruction.node,
    LLM.node,
    LSP.node,
    MCP.node,
    McpAuth.node,
    Command.node,
    Truncate.node,
    ToolRegistry.node,
    Format.node,
    InstanceStore.node,
    Project.node,
    Vcs.node,
    Workspace.node,
    Worktree.node,
    Installation.node,
    ShareNext.node,
    SessionShare.node,
    PublicSessionShare.node,
  ]),
).pipe(Layer.provideMerge(AppNodeBuilderV1.build(Ripgrep.node)), Layer.provideMerge(Observability.layer))

const rt = ManagedRuntime.make(AppLayer, { memoMap })
registerRuntimeCleanup(() => rt.dispose())
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
