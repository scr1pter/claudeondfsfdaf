import os from "node:os"
import { Clock, Context, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { isFreeModelRef } from "@vectordevai/schema/free-model"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Workflow } from "@vectordevai/schema/workflow"
import { Agent } from "@/agent/agent"
import { SubagentModel } from "@/agent/subagent-model"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { SessionMemory } from "@/session/memory"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TaskLimits } from "@/task/limits"
import { TaskManager } from "@/task/manager"
import type { TaskSizeContext } from "@/tool/escalate"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import type { TaskPromptOps, TaskTool } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WorkflowMarkers } from "./constants"
import { WorkflowLibrary } from "./library"
import { WorkflowRunner } from "./runner"
import { WorkflowSources } from "./sources"
import { WorkflowState } from "./state"

export type Input = {
  readonly spec?: string
  readonly name?: string
  readonly inputs?: Readonly<Record<string, unknown>>
  readonly title?: string
  readonly runID?: string
  readonly retryFailed?: boolean
  /** Owner API option only; the model-facing workflow tool rejects this field. */
  readonly quiet?: boolean
}
export type Call = { readonly ctx: Tool.Context; readonly input: Input }
export interface Interface {
  readonly validate: (call: Call) => Effect.Effect<Workflow.Validation, Error>
  readonly launch: (
    call: Call & { readonly task: () => Effect.Effect<Tool.InferDef<typeof TaskTool>> },
  ) => Effect.Effect<Workflow.Started, Error>
}
export class Service extends Context.Service<Service, Interface>()("@vector/WorkflowRuns") {}
export class Error extends Schema.TaggedErrorClass<Error>()("WorkflowRuns.Error", {
  code: Schema.Literals(["invalid", "forbidden", "running", "limit", "not_found"]),
  message: Schema.String,
}) {}

const SPEC = "vector.workflow.spec"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const guests = yield* FreeModelGuests.Service
    const flags = yield* RuntimeFlags.Service
    const library = yield* WorkflowLibrary.Service
    const tasks = yield* TaskManager.Service
    const guard = yield* SpendGuard.Service
    const events = yield* EventV2Bridge.Service
    const sources = yield* WorkflowSources.Service
    const truncate = yield* Truncate.Service
    const fs = yield* FileSystem.FileSystem
    const locks = yield* InstanceState.make(() => Effect.succeed(new Map<SessionID, Semaphore.Semaphore>()))

    const prepare = Effect.fn("WorkflowRuns.prepare")(
      function* (call: Call, stored = false) {
        const parent = yield* sessions.get(call.ctx.sessionID)
        const cfg = yield* config.get()
        const caller = yield* agents.get(call.ctx.agent)
        const catalog = yield* agents.list()
        const entries = yield* library.list()
        const saved = Object.fromEntries(entries.filter((entry) => entry.spec).map((entry) => [entry.name, entry.spec]))
        const named =
          call.input.name === undefined ? undefined : yield* WorkflowLibrary.select(entries, call.input.name)
        if (call.input.name !== undefined && (!named?.spec || call.input.spec !== undefined))
          return yield* new Error({
            code: "invalid",
            message:
              named?.issues?.map((issue) => issue.message).join(" ") || "Use one valid saved workflow name or spec.",
          })
        const source =
          named || stored ? "saved" : call.ctx.extra?.[WorkflowMarkers.USER_START] === true ? "owner" : "model"
        const value = named?.spec ?? call.input.spec
        const parsed = WorkflowSpec.parse(value, { source })
        const planAgents: WorkflowPlan.Agent[] = catalog.map((item) => {
          const permission = Permission.merge(item.permission, parent.permission ?? [])
          const actions = (tool: string) =>
            ["*", ...permission.filter((rule) => rule.permission === tool).map((rule) => rule.pattern)].map(
              (pattern) => Permission.evaluate(tool, pattern, permission).action,
            )
          return {
            name: item.name,
            allowed:
              Permission.evaluate("task", item.name, caller?.permission ?? []).action !== "deny" &&
              Permission.evaluate("task", item.name, caller?.permission ?? [], parent.permission ?? []).action !==
                "deny",
            primary: item.mode === "primary",
            hidden: item.native === true && item.hidden === true,
            research: Agent.researchTools(item.name) !== undefined,
            writes:
              actions("edit").some((action) => action !== "deny") ||
              actions("bash").some((action) => action !== "deny"),
            asks: ["webfetch", "websearch", "bash", "edit", "external_directory"].filter((tool) =>
              actions(tool).includes("ask"),
            ),
          }
        })
        const built = WorkflowPlan.build(value, {
          agents: planAgents,
          inputs: call.input.inputs,
          saved,
          limits: cfg.budget?.workflow,
          cpus: os.availableParallelism(),
          source,
          // Structural planning is pure; selected models/effort are checked with the real provider below.
          modelAllowed: () => true,
        })
        if (!built.ok || !parsed.ok) return { built, agents: planAgents, spec: undefined, parent }
        const message = yield* sessions.findMessage(parent.id, (message) => message.info.id === call.ctx.messageID)
        if (Option.isNone(message) || message.value.info.role !== "assistant")
          return yield* new Error({
            code: "invalid",
            message: "Workflow validation requires the calling assistant's model.",
          })
        const model = message.value.info
        const guest = yield* guests.marked(parent.id)
        const issues = [...built.issues]
        const models: Record<
          string,
          { producer?: string; verifier?: string; effort?: string; verifierEffort?: string }
        > = {}
        for (const expanded of built.stages ?? []) {
          const stage = expanded.stage
          for (const target of [
            {
              agent: stage.agent ?? "general",
              model: stage.model,
              effort: stage.effort,
              verifier: false,
              path: `${expanded.path}/model`,
            },
            ...(stage.verify
              ? [
                  {
                    agent: stage.verify.agent ?? stage.agent ?? "general",
                    model: stage.verify.model ?? stage.model,
                    effort: stage.verify.effort ?? stage.effort,
                    verifier: true,
                    path: `${expanded.path}/verify/model`,
                  },
                ]
              : []),
          ]) {
            const next = catalog.find((item) => item.name === target.agent)
            if (!next) continue
            const choice = yield* SubagentModel.choose({
              parent: {
                model: { providerID: model.providerID, modelID: model.modelID },
                variant: model.variant,
                free: isFreeModelRef({ providerID: model.providerID, modelID: model.modelID }),
                learnedSmall: false,
                guest,
                ...(call.ctx.extra?.effort === "off" ||
                call.ctx.extra?.effort === "default" ||
                call.ctx.extra?.effort === "high"
                  ? { sized: call.ctx.extra.effort }
                  : {}),
                ...(call.ctx.extra?.passdown === "off" ||
                call.ctx.extra?.passdown === "default" ||
                call.ctx.extra?.passdown === "high"
                  ? { passdown: call.ctx.extra.passdown }
                  : {}),
              },
              next,
              ask: { model: target.model, effort: target.effort, fork: false },
              allow: cfg.sizing?.subagents?.models,
              local: Config.local().enabled,
            }).pipe(Effect.provideService(Provider.Service, provider), Effect.result)
            if (choice._tag === "Failure") issues.push({ path: target.path, message: choice.failure.message })
            else
              models[stage.id] = {
                ...models[stage.id],
                [target.verifier ? "verifier" : "producer"]:
                  `${choice.success.model.providerID}/${choice.success.model.modelID}`,
                [target.verifier ? "verifierEffort" : "effort"]: choice.success.effort ?? "default",
              }
          }
        }
        const plan = built.plan && {
          ...built.plan,
          stages: built.plan.stages.map((stage) => ({
            ...stage,
            model: models[stage.id]?.producer ?? stage.model,
            effort: models[stage.id]?.effort ?? stage.effort,
          })),
          ...(named ? { saved: { name: named.name, source: named.source } } : {}),
        }
        return {
          built: { ...built, ok: issues.length === 0, issues, plan },
          agents: planAgents,
          spec: parsed.spec,
          parent,
          model,
          models,
        }
      },
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error({ code: "invalid", message: cause.message }),
      ),
    )

    const validate: Interface["validate"] = Effect.fn("WorkflowRuns.validate")(function* (call) {
      const result = yield* prepare(call)
      return {
        ok: result.built.ok,
        issues: result.built.issues,
        warnings: result.built.warnings,
        ...(result.built.plan ? { plan: result.built.plan } : {}),
      }
    })

    const launch: Interface["launch"] = Effect.fn("WorkflowRuns.launch")(
      function* (call) {
        const parent = yield* sessions.get(call.ctx.sessionID)
        if (parent.parentID)
          return yield* new Error({ code: "forbidden", message: "Workflows start from the main agent." })
        if (yield* guests.marked(parent.id))
          return yield* new Error({ code: "forbidden", message: "Workflows are unavailable in guest conversations." })
        if (!flags.backgroundSubagents)
          return yield* new Error({
            code: "forbidden",
            message: "Background subagents are turned off; workflows cannot start.",
          })
        const size = call.ctx.extra?.taskSize as TaskSizeContext | undefined
        if (size?.capped || size?.tier === "light" || size?.tier === "chat")
          return yield* new Error({
            code: "forbidden",
            message: "Workflows cannot start on a capped or Light request.",
          })
        if (call.ctx.extra?.[WorkflowMarkers.TASK_OFFERED] !== true)
          return yield* new Error({
            code: "forbidden",
            message: "Workflows require task to be offered in this request.",
          })
        const map = yield* InstanceState.get(locks)
        const lock = map.get(parent.id) ?? Semaphore.makeUnsafe(1)
        map.set(parent.id, lock)
        return yield* Effect.gen(function* () {
          const prior = call.input.runID ? yield* sessions.get(SessionID.make(call.input.runID)) : undefined
          const previous = prior && SubagentLifecycle.read(prior)
          if (prior && (prior.parentID !== parent.id || previous?.workflow?.role !== "run"))
            return yield* new Error({
              code: "not_found",
              message: "That workflow does not belong to this conversation.",
            })
          // Observation reconciles abandoned coordinators before counting the conversation's live runs.
          const board = yield* tasks.list({ sessionID: parent.id, active: true, limit: 1000 })
          if (
            prior &&
            board.tasks.some(
              (task) => task.id === prior.id && ["running", "queued", "waiting_on_user"].includes(task.status),
            )
          )
            return yield* new Error({ code: "running", message: "This workflow is already running." })
          const stored = prior
            ? yield* sessions.findMessage(
                prior.id,
                (message) =>
                  message.info.role === "user" &&
                  message.parts.some((part) => part.type === "text" && part.metadata?.[SPEC] === true),
              )
            : Option.none()
          const text = Option.isSome(stored)
            ? stored.value.parts.find((part) => part.type === "text" && part.metadata?.[SPEC] === true)
            : undefined
          const old =
            text?.type === "text" ? Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text.text) : Option.none()
          const oldInput = Option.isSome(old)
            ? Schema.decodeUnknownOption(
                Schema.Struct({
                  spec: Schema.String,
                  inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
                }),
              )(old.value)
            : Option.none()
          if (prior && call.input.spec === undefined && call.input.name === undefined && Option.isNone(oldInput))
            return yield* new Error({ code: "invalid", message: "The saved workflow spec is missing or invalid." })
          const input = { ...(Option.isSome(oldInput) ? oldInput.value : {}), ...call.input }
          if (call.input.name !== undefined) delete input.spec
          const prepared = yield* prepare(
            { ...call, input },
            prior !== undefined && call.input.spec === undefined && call.input.name === undefined,
          )
          if (!prepared.built.ok || !prepared.built.plan || !prepared.built.limits || !prepared.spec || !prepared.model)
            return yield* new Error({
              code: "invalid",
              message:
                prepared.built.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n") ||
                "Invalid workflow.",
            })
          const live = board.tasks.filter((task) => task.workflow?.role === "run")
          if (board.truncated || live.length >= prepared.built.limits.runs)
            return yield* new Error({
              code: "limit",
              message: TaskLimits.workflowRuns(live[0]?.id ?? "another run").message,
            })
          const cfg = yield* config.get()
          const histories = call.ctx.history
            ? yield* call.ctx.history()
            : yield* sessions.messages({ sessionID: parent.id })
          const taints = [SessionMemory.taint(histories)]
          for (const child of yield* sessions.children(parent.id))
            taints.push(SessionMemory.taint(yield* sessions.messages({ sessionID: child.id })))
          const reason = taints.includes("web")
            ? "web"
            : taints.includes("mcp")
              ? "mcp"
              : process.env[ChildEnvironment.AGENT_MARKER] !== undefined
                ? "agent"
                : prepared.built.large
                  ? "large"
                  : undefined
          if (call.ctx.extra?.[WorkflowMarkers.USER_START] !== true)
            yield* call.ctx.ask({
              permission: "workflow",
              patterns: [PermissionPolicy.workflowPattern(reason)],
              always: reason ? [] : ["run"],
              metadata: {
                ...prepared.built.plan,
                delegated: TaskLimits.resolve(cfg, false).budget,
                models: prepared.models,
              },
            })
          if (yield* guests.marked(parent.id))
            return yield* new Error({
              code: "forbidden",
              message:
                "A guest joined while the workflow was being approved. Workflows are unavailable in guest conversations.",
            })
          const current = yield* prepare(
            { ...call, input },
            prior !== undefined && call.input.spec === undefined && call.input.name === undefined,
          )
          if (
            !current.built.ok ||
            WorkflowPlan.canonical(current.parent.permission ?? []) !==
              WorkflowPlan.canonical(prepared.parent.permission ?? []) ||
            WorkflowPlan.canonical(current.built.plan) !== WorkflowPlan.canonical(prepared.built.plan) ||
            WorkflowPlan.canonical(current.models) !== WorkflowPlan.canonical(prepared.models)
          )
            return yield* new Error({
              code: "forbidden",
              message:
                "The workflow's agent permissions or plan changed while approval was pending. Validate and approve the current plan again.",
            })
          const real = call.ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!real)
            return yield* new Error({ code: "invalid", message: "Workflow requires the session prompt operations." })
          const task = yield* call.task()
          const state: { runID?: SessionID } = { runID: prior?.id }
          const title = input.title ?? prepared.spec.title
          const spec = prepared.spec
          const built = prepared.built
          const model = prepared.model
          const revision =
            previous?.workflow?.role === "run"
              ? previous.workflow.revision + Number(call.input.spec !== undefined || call.input.name !== undefined)
              : 1
          const marker: WorkflowMarkers.Run = {
            title,
            revision,
            callerAgent: call.ctx.agent,
            permissionKey: WorkflowPlan.key(prepared.parent.permission ?? []),
            ...(call.ctx.extra?.[WorkflowMarkers.USER_START] === true
              ? { quiet: input.quiet ?? true }
              : previous?.workflow?.role === "run" && previous.workflow.quiet
                ? { quiet: true }
                : {}),
          }
          const ops: TaskPromptOps = {
            cancel: real.cancel,
            resolvePromptParts: real.resolvePromptParts,
            prompt: (prompt) =>
              Effect.gen(function* () {
                if (prompt.sessionID !== state.runID || prompt.agent !== WorkflowMarkers.WORKFLOW_AGENT)
                  return yield* real.prompt(prompt)
                const now = yield* Clock.currentTimeMillis
                const userID = prompt.messageID ?? MessageID.ascending()
                yield* sessions.updateMessage({
                  id: userID,
                  sessionID: prompt.sessionID,
                  role: "user",
                  agent: WorkflowMarkers.WORKFLOW_AGENT,
                  model: { providerID: model.providerID, modelID: model.modelID },
                  time: { created: now },
                })
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  messageID: userID,
                  sessionID: prompt.sessionID,
                  type: "text",
                  synthetic: true,
                  text: JSON.stringify({ spec: JSON.stringify(spec), inputs: input.inputs ?? {} }),
                  metadata: { [SPEC]: true },
                })
                const result = yield* WorkflowRunner.run({
                  runID: prompt.sessionID,
                  rootID: parent.id,
                  spec,
                  built,
                  agents: prepared.agents,
                  retryFailed: input.retryFailed,
                  sessions,
                  task,
                  ops: real,
                  ask: call.ctx.ask,
                  extra: {
                    ...call.ctx.extra,
                    [WorkflowMarkers.RUN]: undefined,
                    [WorkflowMarkers.USER_START]: undefined,
                  },
                  message: {
                    parentID: userID,
                    providerID: model.providerID,
                    modelID: model.modelID,
                    path: model.path,
                    ...(model.variant ? { variant: model.variant } : {}),
                  },
                  events,
                  guard,
                  sources,
                  truncate,
                  fs,
                })
                const last = yield* sessions.findMessage(
                  prompt.sessionID,
                  (message) => message.info.role === "assistant",
                )
                if (Option.isNone(last) || last.value.info.role !== "assistant")
                  return yield* Effect.die(new globalThis.Error("Workflow produced no report message."))
                if (result.outcome === "failed") {
                  const info = yield* sessions.updateMessage({
                    ...last.value.info,
                    error: { name: "APIError", data: { message: result.report.split("\n")[0], isRetryable: false } },
                  })
                  return { ...last.value, info }
                }
                return last.value
              }).pipe(Effect.orDie),
          }
          const savedState =
            previous?.workflow?.role === "run" && previous.workflow.progress.runtime !== undefined
              ? yield* WorkflowState.decode(previous.workflow.progress.runtime)
              : undefined
          const used = savedState?.usage
          const steps = built.limits!.steps - (used?.steps ?? 0)
          const usd = built.limits!.usd === undefined ? undefined : built.limits!.usd - (used?.spentUsd ?? 0)
          if (steps <= 0 || (usd !== undefined && usd <= 0))
            return yield* new Error({
              code: "limit",
              message: "This workflow has used its step or spend budget; raise its limits before resuming.",
            })
          yield* task.execute(
            {
              description: title,
              prompt: JSON.stringify(spec),
              subagent_type: WorkflowMarkers.WORKFLOW_AGENT,
              background: true,
              ...(prior ? { task_id: prior.id } : {}),
              budget: { steps, ...(usd === undefined ? {} : { usd }) },
            },
            {
              ...call.ctx,
              extra: { ...call.ctx.extra, promptOps: ops, [WorkflowMarkers.RUN]: marker },
              metadata: (value) =>
                Effect.gen(function* () {
                  if (typeof value.metadata?.sessionId === "string")
                    state.runID = SessionID.make(value.metadata.sessionId)
                  yield* call.ctx.metadata(value)
                }),
            },
          )
          if (!state.runID)
            return yield* new Error({ code: "invalid", message: "Workflow did not create a run session." })
          return { runID: state.runID, title, plan: built.plan! }
        }).pipe(lock.withPermits(1))
      },
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error({ code: "invalid", message: cause.message }),
      ),
    )
    return Service.of({ validate, launch })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    Agent.node,
    Config.node,
    Provider.node,
    FreeModelGuests.node,
    RuntimeFlags.node,
    WorkflowLibrary.node,
    TaskManager.node,
    SpendGuard.node,
    EventV2Bridge.node,
    WorkflowSources.node,
    Truncate.node,
    LayerNodePlatform.filesystem,
  ],
})
export * as WorkflowRuns from "./runs"
