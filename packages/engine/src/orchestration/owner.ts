import { randomUUID } from "node:crypto"
import { Cause, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Workflow } from "@vectordevai/schema/workflow"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { SessionMemory } from "@/session/memory"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { TaskManager } from "@/task/manager"
import { TaskNotify } from "@/task/notify"
import { ToolRegistry } from "@/tool/registry"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { WorkflowOwnerHandoffFailure } from "./owner-failure"
import { WorkflowMarkers } from "./constants"
import { WorkflowLibrary } from "./library"
import { WorkflowRuns } from "./runs"
import { WorkflowState } from "./state"

export class Error extends Schema.TaggedErrorClass<Error>()("WorkflowOwner.Error", {
  code: Schema.Literals(["invalid", "forbidden", "busy", "running", "limit", "not_found"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly saved: () => Effect.Effect<Workflow.SavedList, Error>
  readonly validate: (input: Workflow.ValidateInput) => Effect.Effect<Workflow.Validation, Error>
  /** Called only after the HTTP/CLI boundary has established owner identity and session control. */
  readonly start: (sessionID: SessionID, input: WorkflowRuns.Input) => Effect.Effect<Workflow.Started, Error>
  readonly list: (sessionID: SessionID) => Effect.Effect<Workflow.RunList, Error>
  readonly get: (sessionID: SessionID, runID: SessionID, owner: boolean) => Effect.Effect<Workflow.RunDetail, Error>
}
export class Service extends Context.Service<Service, Interface>()("@vector/WorkflowOwner") {}

const sourceSchema = Schema.Struct({
  spec: Schema.String,
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
})
const bounded = (value: string, bytes: number) => {
  let text = Buffer.from(value).subarray(0, bytes).toString("utf8")
  while (Buffer.byteLength(text) > bytes) text = text.slice(0, -1)
  return text
}
const mapped = (cause: { readonly message: string; readonly code?: string }) =>
  new Error({
    code:
      cause.code === "not_found" || cause.code === "forbidden" || cause.code === "running" || cause.code === "limit"
        ? cause.code
        : "invalid",
    message: cause.message,
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const prompts = yield* SessionPrompt.Service
    const state = yield* SessionRunState.Service
    const status = yield* SessionStatus.Service
    const runs = yield* WorkflowRuns.Service
    const library = yield* WorkflowLibrary.Service
    const registry = yield* ToolRegistry.Service
    const permission = yield* Permission.Service
    const tasks = yield* TaskManager.Service
    const guests = yield* FreeModelGuests.Service
    const flags = yield* RuntimeFlags.Service
    const notes = yield* TaskNotify.Service

    const requireRun = Effect.fn("WorkflowOwner.requireRun")(function* (sessionID: SessionID, runID: SessionID) {
      const run = yield* sessions
        .get(runID)
        .pipe(Effect.mapError(() => new Error({ code: "not_found", message: "Workflow run not found." })))
      const record = SubagentLifecycle.read(run)
      if (run.parentID !== sessionID || record?.workflow?.role !== "run")
        return yield* new Error({ code: "not_found", message: "That workflow does not belong to this conversation." })
      return { run, record, workflow: record.workflow }
    })
    const source = Effect.fn("WorkflowOwner.source")(function* (runID: SessionID) {
      const message = yield* sessions.findMessage(
        runID,
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.metadata?.[WorkflowMarkers.SPEC] === true),
      )
      const part = Option.isSome(message)
        ? message.value.parts.find((part) => part.type === "text" && part.metadata?.[WorkflowMarkers.SPEC] === true)
        : undefined
      const json =
        part?.type === "text" ? Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(part.text) : Option.none()
      const decoded = Option.isSome(json) ? Schema.decodeUnknownOption(sourceSchema)(json.value) : Option.none()
      if (Option.isNone(decoded))
        return yield* new Error({ code: "invalid", message: "The saved workflow spec is missing or invalid." })
      return decoded.value
    }, Effect.mapError(mapped))

    const saved: Interface["saved"] = () =>
      library.list().pipe(
        Effect.map((entries) => ({ workflows: entries.map(({ spec: _, ...entry }) => entry) })),
        Effect.mapError(mapped),
      )
    const validate: Interface["validate"] = Effect.fn("WorkflowOwner.validate")(function* (input) {
      const agent = yield* agents.defaultInfo()
      const model = agent.model ?? (yield* provider.defaultModel())
      return yield* runs.preview(input, { agent: agent.name, model })
    }, Effect.mapError(mapped))

    const start: Interface["start"] = Effect.fn("WorkflowOwner.start")(function* (sessionID, input) {
      // The shared runner returns a real transcript message: a concurrent prompt may join it and expects WithParts.
      const result: { started?: Workflow.Started } = {}
      let assistant: SessionV1.Assistant | undefined
      let part: SessionV1.ToolPart | undefined
      const abort = new AbortController()
      const work = Effect.gen(function* () {
        yield* status.set(sessionID, { type: "busy" })
        // Reserve transcript order before slow validation; concurrent human messages must remain newer.
        const userID = MessageID.ascending()
        const assistantID = MessageID.ascending()
        const now = yield* Clock.currentTimeMillis
        const parent = yield* sessions.get(sessionID)
        if (parent.parentID || parent.agent === WorkflowMarkers.WORKFLOW_AGENT)
          return yield* new Error({ code: "forbidden", message: "Workflows start from the main conversation." })
        if (parent.revert)
          return yield* new Error({
            code: "busy",
            message: "Finish or undo the session revert before starting a workflow.",
          })
        if (!flags.backgroundSubagents)
          return yield* new Error({
            code: "forbidden",
            message: "Background subagents are turned off; workflows cannot start.",
          })
        if (yield* guests.marked(sessionID))
          return yield* new Error({ code: "forbidden", message: "Workflows are unavailable in guest conversations." })
        yield* prompts.admit(sessionID)
        const agent = yield* agents.defaultInfo()
        if (!agent) return yield* new Error({ code: "invalid", message: "The conversation's agent is unavailable." })
        const ruleset = Permission.merge(agent.permission, parent.permission ?? [])
        const disabled = Permission.disabled(["task", "workflow"], ruleset)
        if (disabled.has("task") || disabled.has("workflow"))
          return yield* new Error({
            code: "forbidden",
            message: "Task and workflow permission must be available to start a workflow.",
          })
        const selected = yield* prompts.currentModel(sessionID, agent.model)
        const previous = input.runID ? yield* requireRun(sessionID, SessionID.make(input.runID)) : undefined
        if (previous) {
          const current = yield* tasks.inspect({ sessionID, taskID: previous.run.id })
          if (["running", "queued", "waiting_on_user"].includes(current.task.status))
            return yield* new Error({ code: "running", message: "This workflow is already running." })
        }
        const resolved = yield* runs.resolve(sessionID, input)
        const prepared = resolved.input
        const validation = yield* runs.preview(
          prepared,
          { agent: agent.name, permission: parent.permission, model: selected },
          resolved.stored,
        )
        if (!validation.ok || !validation.plan)
          return yield* new Error({
            code: "invalid",
            message:
              validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n") || "Invalid workflow.",
          })
        const context = yield* InstanceState.context
        const title = input.title ?? validation.plan.title
        const text = `${previous ? "Resume" : "Run"} workflow ${title} with ${JSON.stringify(prepared.inputs ?? {})}`
        // Like an owner-invoked command, this engine-created user message is a real human action for resume gating.
        const user = yield* sessions.updateMessage({
          id: userID,
          sessionID,
          role: "user",
          agent: agent.name,
          model: selected,
          time: { created: now },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: user.id,
          type: "text",
          text,
          metadata: { [SessionMemory.COMMAND]: { source: "command", arguments: text } },
        })
        yield* notes.unfence(sessionID)

        const currentAssistant: SessionV1.Assistant = yield* sessions
          .updateMessage({
            id: assistantID,
            sessionID,
            role: "assistant",
            parentID: user.id,
            agent: agent.name,
            mode: agent.name,
            modelID: selected.modelID,
            providerID: selected.providerID,
            ...(selected.variant ? { variant: selected.variant } : {}),
            path: { cwd: context.directory, root: context.worktree },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now },
          })
          .pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                assistant = value
              }),
            ),
            Effect.uninterruptible,
          )
        const args = { action: previous ? "resume" : "run", ...input }
        let currentPart: SessionV1.ToolPart = yield* sessions
          .updatePart({
            id: PartID.ascending(),
            sessionID,
            messageID: currentAssistant.id,
            type: "tool",
            tool: "workflow",
            callID: `workflow_owner_${randomUUID()}`,
            state: {
              status: "running",
              input: args,
              metadata: { [WorkflowMarkers.OWNER_START]: true },
              time: { start: now },
            },
          })
          .pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                part = value
              }),
            ),
            Effect.uninterruptible,
          )
        const launched = yield* runs.launch({
          input,
          task: () => registry.named().pipe(Effect.map((tools) => tools.task)),
          ctx: {
            sessionID,
            messageID: currentAssistant.id,
            callID: currentPart.callID,
            agent: agent.name,
            abort: abort.signal,
            messages: yield* sessions.messages({ sessionID }),
            extra: {
              [WorkflowMarkers.USER_START]: true,
              [WorkflowMarkers.TASK_OFFERED]: true,
              promptOps: {
                cancel: prompts.cancel,
                resolvePromptParts: prompts.resolvePromptParts,
                prompt: (input: SessionPrompt.PromptInput) => prompts.prompt(input).pipe(Effect.orDie),
              },
            },
            ask: (request) => permission.ask({ ...request, sessionID, ruleset }).pipe(Effect.orDie),
            metadata: (value) =>
              Effect.gen(function* () {
                if (currentPart.state.status === "running") {
                  currentPart = yield* sessions.updatePart({
                    ...currentPart,
                    state: {
                      ...currentPart.state,
                      ...value,
                      metadata: { ...value.metadata, [WorkflowMarkers.OWNER_START]: true },
                    },
                  })
                  part = currentPart
                }
              }),
          },
        })
        result.started = launched
        currentPart = yield* sessions.updatePart({
          ...currentPart,
          state: {
            status: "completed",
            input: args,
            title: launched.title,
            output: JSON.stringify(launched),
            metadata: { action: args.action, runID: launched.runID, [WorkflowMarkers.OWNER_START]: true },
            time: { start: now, end: yield* Clock.currentTimeMillis },
          },
        })
        const reply = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: currentAssistant.id,
          type: "text",
          text: `${previous ? "Resumed" : "Started"} workflow ${launched.title} (${launched.runID}).`,
        })
        const info = yield* sessions.updateMessage({
          ...currentAssistant,
          finish: "stop",
          time: { ...currentAssistant.time, completed: yield* Clock.currentTimeMillis },
        })
        yield* sessions.touch(sessionID)
        return { info, parts: [currentPart, reply] }
      }).pipe(
        Effect.onExit((exit) => {
          if (exit._tag === "Success") return Effect.void
          abort.abort()
          const message = Cause.hasInterrupts(exit.cause) ? "Interrupted" : String(Cause.squash(exit.cause))
          return Effect.gen(function* () {
            if (part)
              yield* sessions.updatePart({
                ...part,
                state: {
                  status: "error",
                  input: part.state.input,
                  error: message,
                  metadata: { [WorkflowMarkers.OWNER_START]: true },
                  time: {
                    start: part.state.status === "pending" ? Date.now() : part.state.time.start,
                    end: yield* Clock.currentTimeMillis,
                  },
                },
              })
            if (assistant)
              yield* sessions.updateMessage({
                ...assistant,
                finish: "stop",
                time: { ...assistant.time, completed: yield* Clock.currentTimeMillis },
                error: Cause.hasInterrupts(exit.cause)
                  ? { name: "MessageAbortedError", data: { message } }
                  : { name: "APIError", data: { message, isRetryable: false } },
              })
          })
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.die(new WorkflowOwnerHandoffFailure(Cause.squash(cause))),
        ),
        Effect.orDie,
      )
      yield* state.startRunning(sessionID, Effect.interrupt, work).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt
          const failed = Cause.squash(cause)
          const error = failed instanceof WorkflowOwnerHandoffFailure ? failed.original : failed
          if (error instanceof Error) return Effect.fail(error)
          if (error instanceof Session.BusyError)
            return Effect.fail(
              new Error({ code: "busy", message: "This conversation is busy. Start the workflow after it finishes." }),
            )
          if (error instanceof WorkflowRuns.Error || error instanceof TaskManager.Error)
            return Effect.fail(mapped(error))
          return Effect.fail(
            new Error({
              code: "invalid",
              message: error instanceof globalThis.Error ? error.message : "Could not start the workflow.",
            }),
          )
        }),
      )
      if (!result.started) return yield* new Error({ code: "invalid", message: "The workflow start did not complete." })
      return result.started
    })

    const list: Interface["list"] = Effect.fn("WorkflowOwner.list")(function* (sessionID) {
      const result = yield* tasks.list({ sessionID, workflows: true, limit: 200 })
      if (result.truncated)
        return yield* new Error({
          code: "limit",
          message: "This conversation has too many workflow runs to list at once. Inspect a known run ID.",
        })
      return { runs: result.tasks }
    }, Effect.mapError(mapped))

    const get: Interface["get"] = Effect.fn("WorkflowOwner.get")(function* (sessionID, runID, owner) {
      yield* requireRun(sessionID, runID)
      const inspected = yield* tasks.inspect({ sessionID, taskID: runID })
      const current = yield* requireRun(sessionID, runID)
      const state =
        current.workflow.progress.runtime === undefined
          ? undefined
          : yield* WorkflowState.decode(current.workflow.progress.runtime)
      const nodes = state?.nodes ?? []
      const report = current.workflow.progress.report
      // A queued coordinator may not have persisted its synthetic spec yet. The owner-only field is optional.
      const saved = owner ? yield* source(runID).pipe(Effect.option) : Option.none()
      return {
        task: inspected.task,
        ...(Option.isSome(saved) ? { spec: saved.value.spec } : {}),
        nodes: nodes
          .slice(0, 500)
          .map((node) => ({
            key: node.key,
            stage: node.stage,
            phase: node.phase ?? "",
            item: node.item ?? "",
            status: node.status,
            sessionID: node.sessionID,
            round: node.round,
            verified: node.verified,
            ...(node.error === undefined ? {} : { error: bounded(node.error, 1024) }),
            ...(node.output && "inline" in node.output
              ? {
                  preview: bounded(
                    typeof node.output.inline === "string" ? node.output.inline : JSON.stringify(node.output.inline),
                    2048,
                  ),
                }
              : {}),
          })),
        truncated: nodes.length > 500,
        ...(typeof report === "string" ? { report: bounded(report, 64 * 1024) } : {}),
      }
    }, Effect.mapError(mapped))
    return Service.of({ saved, validate, start, list, get })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    Agent.node,
    Provider.node,
    SessionPrompt.node,
    SessionRunState.node,
    SessionStatus.node,
    WorkflowRuns.node,
    WorkflowLibrary.node,
    ToolRegistry.node,
    Permission.node,
    TaskManager.node,
    FreeModelGuests.node,
    RuntimeFlags.node,
    TaskNotify.node,
  ],
})
export * as WorkflowOwner from "./owner"
