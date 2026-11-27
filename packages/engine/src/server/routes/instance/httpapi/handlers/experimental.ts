import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { ComputerAvailability } from "@/computer/availability"
import { Permission } from "@/permission"
import { WorkflowOwner } from "@/orchestration/owner"
import { PlaybookClient } from "@/orchestration/playbooks"
import { HostedFollow } from "@/hosted/follow"
import { CloudBrain } from "@/brain/run-bundle"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { TaskManager } from "@/task/manager"
import { DesktopTasks } from "@/task/desktop"
import { TaskBridge } from "@vectordevai/schema/task-bridge"
import type { Task } from "@vectordevai/schema/task"
import type { TaskPromptOps } from "@/tool/task"
import { SubagentLifecycle } from "@/tool/subagent-lifecycle"
import { UnattendedShell } from "@/session/unattended-shell"
import { SessionID } from "@/session/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { FSUtil } from "@vectordevai/core/fs-util"
import { AppProcess } from "@vectordevai/core/process"
import path from "node:path"
import { Effect, Exit, Option, Schema } from "effect"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { freeModelMayTrain, FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  SessionListQuery,
  SessionStopInput,
  TaskBackgroundInput,
  TaskChangesQuery,
  TaskDiscardInput,
  TaskMergeInput,
  ToolListQuery,
  WorktreeApiError,
  TaskApiError,
  WorkflowApiError,
  AccountWorkApiError,
  TaskListQuery,
  TaskMessageInput,
  TaskResumeInput,
  TaskStopInput,
  TaskWaitInput,
} from "../groups/experimental"
import {
  RequestPrincipal,
  allowsSession,
  guestWorkspaceDirectory,
} from "@vectordevai/protocol/middleware/authorization"
import { ForbiddenError } from "@vectordevai/protocol/errors"
import { RequestOwner } from "@vectordevai/server/request-owner"
import { SessionAudienceHttp } from "@vectordevai/server/session-audience"
import { allowsSessionID } from "./session-access"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

type TaskResult = {
  readonly task?: Task.Info
  readonly tasks?: readonly Task.Info[]
  readonly shells?: readonly Task.Shell[] | number
}

// A task result without any helper's absolute isolation directory, or any background command's output path (I19).
function withoutDirectories<T extends TaskResult>(result: T): T {
  const hide = (task: Task.Info): Task.Info =>
    task.isolation?.directory === undefined
      ? task
      : { ...task, isolation: SubagentLifecycle.withoutDirectory(task.isolation) }
  const unpathed = (shell: Task.Shell): Task.Shell => {
    const { outputPath: _, ...rest } = shell
    return rest
  }
  return {
    ...result,
    ...(result.task ? { task: hide(result.task) } : {}),
    ...(result.tasks ? { tasks: result.tasks.map(hide) } : {}),
    ...(Array.isArray(result.shells) ? { shells: result.shells.map(unpathed) } : {}),
  }
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const flags = yield* RuntimeFlags.Service
    const computer = yield* ComputerAvailability.Service
    const tasks = yield* TaskManager.Service
    const workflow = yield* Effect.serviceOption(WorkflowOwner.Service)
    const playbooks = yield* Effect.serviceOption(PlaybookClient.Service)
    const hosted = yield* Effect.serviceOption(HostedFollow.Service)
    const cloudBrain = yield* Effect.serviceOption(CloudBrain.Service)
    const desktop = yield* DesktopTasks.Service
    const prompts = yield* SessionPrompt.Service
    // The server provides it to every handler; a test that builds these handlers alone may leave it out.
    const provider = yield* Effect.serviceOption(Provider.Service)
    const taskPrompts: TaskPromptOps = {
      cancel: prompts.cancel,
      resolvePromptParts: prompts.resolvePromptParts,
      prompt: (input) => prompts.prompt(input).pipe(Effect.orDie),
    }
    // A guest's work must not reach a free model that may train through the owner's acceptance.
    const guestPrompts: TaskPromptOps = {
      ...taskPrompts,
      prompt: (input) => prompts.prompt(input, { refuseTrainingFreeModels: true }).pipe(Effect.orDie),
    }

    const access = Effect.fn("ExperimentalHttpApi.taskAccess")(function* (sessionID: SessionID, control = false) {
      const principal = yield* RequestPrincipal
      // Workspace visibility does not grant control over another participant's workers.
      if (control ? allowsSession(principal, sessionID) : yield* allowsSessionID(sessions, principal, sessionID)) return
      return yield* new ForbiddenError({ message: "This session's tasks are outside your authorized sessions" })
    })
    const taskError = <A, R>(effect: Effect.Effect<A, TaskManager.Error, R>) =>
      effect.pipe(Effect.mapError((error) => new TaskApiError({ code: error.code, message: error.message })))
    // A helper's absolute isolation directory and details go only to the authenticated owner (I19). A controlling
    // guest, or owner credentials relaying a guest, are still guests.
    const shown = <T extends TaskResult>(result: T) =>
      Effect.map(RequestOwner.owner, (owner) => (owner ? result : withoutDirectories(result)))

    const taskList = Effect.fn("ExperimentalHttpApi.taskList")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof TaskListQuery.Type
    }) {
      yield* access(ctx.params.sessionID)
      const result = yield* taskError(
        tasks.list({
          sessionID: ctx.params.sessionID,
          descendants: ctx.query.descendants,
          limit: ctx.query.limit,
          active: ctx.query.active,
          shells: ctx.query.shells,
        }),
      )
      // The limits line carries the owner's configured limits, which only the owner sees (I19).
      const { limits, ...rest } = result
      const owner = yield* RequestOwner.owner
      return yield* shown(owner && limits ? { ...rest, limits } : rest)
    })

    const taskInspect = Effect.fn("ExperimentalHttpApi.taskInspect")(function* (ctx: {
      params: { sessionID: SessionID; taskID: string }
    }) {
      yield* access(ctx.params.sessionID)
      return yield* shown(yield* taskError(tasks.inspect(ctx.params)))
    })

    const taskMessage = Effect.fn("ExperimentalHttpApi.taskMessage")(function* (ctx: {
      params: { sessionID: SessionID; taskID: string }
      payload: typeof TaskMessageInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      const guest = !(yield* RequestOwner.owner)
      return yield* taskError(
        tasks.message({ ...ctx.params, ...ctx.payload, origin: "user" }, guest ? guestPrompts : taskPrompts),
      )
    })

    // Resume (D.3): the user continues stopped, failed or interrupted helpers. A guest's resume runs under the guest
    // limits and budget, and is refused at once for a helper on a free model that may train. Only this session's own
    // children are checked, so the answer says nothing about other sessions (I19); resume refuses those itself.
    const taskResume = Effect.fn("ExperimentalHttpApi.taskResume")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskResumeInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      const guest = !(yield* RequestOwner.owner)
      if (guest && Option.isSome(provider))
        for (const taskID of new Set(ctx.payload.taskIDs)) {
          const id = Schema.decodeUnknownOption(SessionID)(taskID)
          const record = Option.isNone(id)
            ? undefined
            : yield* sessions.get(id.value).pipe(
                Effect.map((child) =>
                  child.parentID === ctx.params.sessionID ? SubagentLifecycle.read(child) : undefined,
                ),
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
          const model =
            record &&
            (yield* provider.value
              .getModel(ProviderV2.ID.make(record.model.providerID), ModelV2.ID.make(record.model.modelID))
              .pipe(Effect.catchCause(() => Effect.succeed(undefined))))
          if (model && freeModelMayTrain(model))
            return yield* new TaskApiError({ code: "forbidden", message: FREE_MODEL_TRAINING_OWNER_ONLY })
        }
      return yield* shown(
        yield* taskError(
          tasks.resume(
            { sessionID: ctx.params.sessionID, ...ctx.payload, origin: "user", guest },
            guest ? guestPrompts : taskPrompts,
          ),
        ),
      )
    })

    const taskStop = Effect.fn("ExperimentalHttpApi.taskStop")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskStopInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      return yield* shown(yield* taskError(tasks.stop({ ...ctx.params, ...ctx.payload, origin: "user" }, taskPrompts)))
    })

    // "Stop including helpers" (5.D.1). Plain abort stays as it was, so revert, undo and halt never stop helpers.
    const sessionStop = Effect.fn("ExperimentalHttpApi.sessionStop")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SessionStopInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      // The session in the path is the one stopped, whatever the body names (Track B B09).
      return yield* shown(
        yield* taskError(tasks.interrupt({ ...ctx.payload, sessionID: ctx.params.sessionID }, taskPrompts)),
      )
    })

    // Move to background (5.D.2): the session's running foreground subagents, or the selected ones.
    const taskBackground = Effect.fn("ExperimentalHttpApi.taskBackground")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: void | typeof TaskBackgroundInput.Type
    }) {
      yield* access(ctx.params.sessionID, true)
      return yield* shown(
        yield* taskError(tasks.promote({ sessionID: ctx.params.sessionID, taskIDs: ctx.payload?.taskIDs })),
      )
    })

    const taskWait = Effect.fn("ExperimentalHttpApi.taskWait")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskWaitInput.Type
    }) {
      yield* access(ctx.params.sessionID)
      return yield* shown(yield* taskError(tasks.wait({ ...ctx.params, ...ctx.payload })))
    })

    // Owner-only routes refuse a guest, a guest in control and owner credentials that relay a guest alike (I11).
    const owner = (message: string) =>
      Effect.gen(function* () {
        if (!(yield* RequestOwner.owner)) return yield* new ForbiddenError({ message })
      })
    const bridgeOwner = owner("Desktop task connections require the authenticated server owner.")

    // Route 4: the owner gets the full changes; another viewer with ordinary view scope gets only the server-built
    // counts projection, which reads the registry and never Git. The usual raw-content check would refuse every
    // owner-only family, so plain view scope is checked here; no header or query flag widens the projection.
    const taskChanges = Effect.fn("ExperimentalHttpApi.taskChanges")(function* (ctx: {
      params: { sessionID: SessionID; taskID: string }
      query: typeof TaskChangesQuery.Type
    }) {
      if (yield* RequestOwner.owner)
        return yield* taskError(tasks.changes({ ...ctx.params, diff: ctx.query.diff, control: true }))
      const principal = yield* RequestPrincipal
      const viewable =
        allowsSession(principal, ctx.params.sessionID) ||
        (yield* sessions.get(ctx.params.sessionID).pipe(
          Effect.map((item) => guestWorkspaceDirectory(principal, item.workspaceID) === item.directory),
          Effect.catchCause(() => Effect.succeed(false)),
        ))
      if (!viewable)
        return yield* new ForbiddenError({ message: "This session's tasks are outside your authorized sessions" })
      return SessionAudienceHttp.projected(HttpServerResponse.jsonUnsafe(yield* taskError(tasks.counts(ctx.params))))
    })
    const taskMerge = Effect.fn("ExperimentalHttpApi.taskMerge")(function* (ctx: {
      params: { sessionID: SessionID; taskID: string }
      payload: void | typeof TaskMergeInput.Type
    }) {
      yield* owner("Only the server owner can merge or discard a subagent's worktree.")
      return yield* taskError(
        tasks.merge({
          ...ctx.params,
          files: ctx.payload?.files,
          includeStacked: ctx.payload?.includeStacked,
          force: ctx.payload?.force,
          by: { kind: "owner" },
        }),
      )
    })
    const taskDiscard = Effect.fn("ExperimentalHttpApi.taskDiscard")(function* (ctx: {
      params: { sessionID: SessionID; taskID: string }
      payload: void | typeof TaskDiscardInput.Type
    }) {
      yield* owner("Only the server owner can merge or discard a subagent's worktree.")
      return yield* taskError(tasks.discard({ ...ctx.params, reason: ctx.payload?.reason, by: { kind: "owner" } }))
    })
    const taskBridgeRegister = Effect.fn("ExperimentalHttpApi.taskBridgeRegister")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskBridge.RegisterInput.Type
    }) {
      yield* bridgeOwner
      return yield* desktop
        .register({ ...ctx.params, ...ctx.payload })
        .pipe(Effect.mapError((error) => new TaskApiError({ code: error.code, message: error.message })))
    })
    const taskBridgePoll = Effect.fn("ExperimentalHttpApi.taskBridgePoll")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskBridge.PollInput.Type
    }) {
      yield* bridgeOwner
      return yield* desktop
        .poll({ ...ctx.params, ...ctx.payload })
        .pipe(Effect.mapError((error) => new TaskApiError({ code: error.code, message: error.message })))
    })
    const taskBridgeReceipt = Effect.fn("ExperimentalHttpApi.taskBridgeReceipt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof TaskBridge.ReceiptInput.Type
    }) {
      yield* bridgeOwner
      return yield* desktop
        .receipt({ ...ctx.params, ...ctx.payload })
        .pipe(Effect.mapError((error) => new TaskApiError({ code: error.code, message: error.message })))
    })

    const workflowService = Effect.gen(function* () {
      if (Option.isNone(workflow))
        return yield* new WorkflowApiError({ code: "invalid", message: "Workflow service is unavailable." })
      return workflow.value
    })
    const workflowOwner = Effect.gen(function* () {
      if (!(yield* RequestOwner.owner))
        return yield* new ForbiddenError({ message: "Only the server owner can validate or start workflows." })
    })
    const accountOwner = Effect.gen(function* () {
      if (!(yield* RequestOwner.owner)) return yield* new ForbiddenError({ message: "Only the server owner can manage account work." })
    })
    const accountError = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((error) => new AccountWorkApiError({ message: error.message })))
    const workflowError = <A, R>(effect: Effect.Effect<A, WorkflowOwner.Error, R>) =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new WorkflowApiError({
              code: error.code,
              message: error.message,
              ...(error.issues?.length ? { issues: error.issues } : {}),
            }),
        ),
      )

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      const agent = yield* agents.defaultInfo()
      const disabled = Permission.disabled(["task", "workflow"], agent.permission)
      return {
        computer: yield* computer.capabilities(),
        workflows: flags.backgroundSubagents && !disabled.has("task") && !disabled.has("workflow"),
        backgroundSubagents: flags.backgroundSubagents,
        subagentLimits: true,
        workDelegation: true,
        sessionStop: true,
        taskPromote: true,
        taskResume: true,
        taskAttention: true,
        taskIsolation: true,
        backgroundShells: true,
        vectorscopeSettings: true,
        vectorscopeRuns: true,
        // Owner data controls only; this does not advertise automatic review-context consumption.
        vectorscopeReviewMemoryControls: true,
        // The routes exist; the owner setting, the platform and a CI job are checked on every call.
        vectorscopeLocalFixes: true,
        // A prompt's codeReview field asks for a VectorScope review once the run that changed files is done.
        codeReviewAfterTask: true,
        connections: flags.experimentalConnect,
      }
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      // This list spans every project on the server; a guest's is narrowed to the workspace it was invited to, where
      // the routing already placed this request.
      const scoped = ctx.query.directory || (yield* RequestPrincipal).kind !== "owner"
      const directory = scoped ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        internal: ctx.query.internal,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionUsage = Effect.fn("ExperimentalHttpApi.sessionUsage")(function* () {
      // The owner's usage spans every project; a guest sees only the workspace it was invited to, as with the list.
      if ((yield* RequestPrincipal).kind === "owner") return yield* sessions.usage()
      return yield* sessions.usage({ directory: yield* InstanceState.directory })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* access(ctx.params.sessionID, true)
      // The older form of the task background route: whether anything moved, and false for a session it cannot reach.
      const result = yield* tasks
        .promote({ sessionID: ctx.params.sessionID })
        .pipe(Effect.catchTag("TaskManager.Error", () => Effect.succeed({ tasks: [] })))
      return result.tasks.length > 0
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("brainPreview", ({ payload }) => Effect.gen(function* () {
        yield* accountOwner
        if (Option.isNone(cloudBrain)) return yield* new AccountWorkApiError({ message: "Update this engine to preview repository Brain context." })
        const prepared = yield* cloudBrain.value.preview({ ...payload, ownerStartedDesktop: true }).pipe(
          Effect.mapError((error) => new AccountWorkApiError({ message: "message" in error ? String(error.message) : "Cannot prepare repository Brain context." })),
        )
        return { path: "brain/bundle.json" as const, base64url: prepared.bytes.toString("base64url"),
          sha256: prepared.sha256, bytes: prepared.bytes.length, entries: prepared.entries, skills: prepared.skills }
      }))
      .handle("brainProposalsImport", ({ payload }) => Effect.gen(function* () {
        yield* accountOwner
        if (Option.isNone(cloudBrain)) return yield* new AccountWorkApiError({ message: "Update this engine to import returned Brain drafts." })
        const bytes = Buffer.from(payload.base64url, "base64url")
        if (bytes.length > 512 * 1024 || bytes.toString("base64url") !== payload.base64url)
          return yield* new AccountWorkApiError({ message: "Invalid returned Brain attachment encoding." })
        const imported = yield* accountError(cloudBrain.value.importProposals({ path: payload.path, bytes,
          sha256: payload.sha256, publicRepository: payload.publicRepository }))
        return { proposed: imported.entries.length, known: imported.known, refused: imported.refused, over: imported.over }
      }))
      .handle("playbooksList", () => Effect.gen(function* () {
        yield* accountOwner
        if (Option.isNone(playbooks)) return yield* new AccountWorkApiError({ message: "Update this engine to install Playbooks." })
        return yield* accountError(playbooks.value.list())
      }))
      .handle("playbookInstall", ({ payload }) => Effect.gen(function* () {
        yield* accountOwner
        if (Option.isNone(playbooks)) return yield* new AccountWorkApiError({ message: "Update this engine to install Playbooks." })
        return yield* accountError(playbooks.value.install(payload))
      }))
      .handle("hostedJobs", ({ params }) => Effect.gen(function* () {
        yield* accountOwner
        yield* access(params.sessionID, true)
        if (Option.isNone(hosted)) return yield* new AccountWorkApiError({ message: "Update this engine to reconnect hosted jobs." })
        return yield* accountError(hosted.value.resume(params.sessionID, taskPrompts))
      }))
      .handle("hostedJobAttach", ({ params, payload }) => Effect.gen(function* () {
        yield* accountOwner
        yield* access(params.sessionID, true)
        if (Option.isNone(hosted)) return yield* new AccountWorkApiError({ message: "Update this engine to reconnect hosted jobs." })
        return yield* accountError(hosted.value.attach(params.sessionID, payload.jobID, taskPrompts))
      }))
      .handle("workflowSaved", () =>
        Effect.gen(function* () {
          yield* workflowOwner
          const service = yield* workflowService
          return yield* workflowError(service.saved())
        }),
      )
      .handle("workflowValidate", ({ payload }) =>
        Effect.gen(function* () {
          yield* workflowOwner
          const service = yield* workflowService
          return yield* workflowError(service.validate(payload))
        }),
      )
      .handle("workflowStart", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* workflowOwner
          yield* access(params.sessionID, true)
          const service = yield* workflowService
          return yield* workflowError(service.start(params.sessionID, payload))
        }),
      )
      .handle("workflowList", ({ params }) =>
        Effect.gen(function* () {
          yield* access(params.sessionID)
          const service = yield* workflowService
          return yield* workflowError(service.list(params.sessionID))
        }),
      )
      .handle("workflowGet", ({ params }) =>
        Effect.gen(function* () {
          yield* access(params.sessionID)
          const service = yield* workflowService
          return yield* workflowError(service.get(params.sessionID, params.runID, yield* RequestOwner.owner))
        }),
      )
      .handle("workflowResume", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* workflowOwner
          yield* access(params.sessionID, true)
          const service = yield* workflowService
          return yield* workflowError(service.start(params.sessionID, { ...(payload ?? {}), runID: params.runID }))
        }),
      )
      .handle("capabilities", capabilities)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionUsage", sessionUsage)
      .handle("sessionBackground", sessionBackground)
      .handle("sessionStop", sessionStop)
      .handle("taskList", taskList)
      .handle("taskInspect", taskInspect)
      .handle("taskMessage", taskMessage)
      .handle("taskStop", taskStop)
      .handle("taskWait", taskWait)
      .handle("taskBackground", taskBackground)
      .handle("taskResume", taskResume)
      .handle("taskChanges", taskChanges)
      .handle("taskMerge", taskMerge)
      .handle("taskDiscard", taskDiscard)
      .handle("taskBridgeRegister", taskBridgeRegister)
      .handle("taskBridgePoll", taskBridgePoll)
      .handle("taskBridgeReceipt", taskBridgeReceipt)
      .handle("resource", resource)
  }),
)

// Vector everywhere's job checkout. Every refusal has a fixed message with no path or request text, and none of them
// creates anything.
const UNATTENDED_OWNER = "Unattended worktrees require the authenticated server owner."
const UNATTENDED_INVALID = "Invalid unattended worktree request."
const UNATTENDED_OFF = "Vector everywhere is off for this folder."
const UNATTENDED_UNAVAILABLE = "The allowed folder is not available."
const UNATTENDED_CLOSED = "This project is not open in Vector. No unattended worktree was created."
const UNATTENDED_UNTRUSTED = "This project is not trusted. No unattended worktree was created."
const UNATTENDED_SHELL_OWNER = "The unattended shell policy requires the authenticated server owner."

// A forwarded guest request carries owner credentials, so the credential alone does not make the owner.
const requireOwner = Effect.fnUntraced(function* (message: string) {
  if (!(yield* RequestOwner.owner)) return yield* new ForbiddenError({ message })
})

export const unattendedWorktreeHandlers = HttpApiBuilder.group(InstanceHttpApi, "unattended-worktree", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const store = yield* InstanceStore.Service
    const worktree = yield* Worktree.Service

    const policy = Effect.fn("UnattendedWorktreeHttpApi.policy")(function* () {
      yield* requireOwner(UNATTENDED_OWNER)
      return { policy: "unattended-v1" as const }
    })

    // Each check runs only once those above it pass. The allowlist runs before anything looks for an instance, and only
    // an instance already loaded in this engine (by any authenticated request) is used: creating a job's checkout never
    // loads one, so it never starts the project's plugins, language servers or dependency installs.
    const create = Effect.fn("UnattendedWorktreeHttpApi.create")(function* (ctx: {
      payload: Worktree.UnattendedInput
    }) {
      yield* requireOwner(UNATTENDED_OWNER)
      const directory = ctx.payload.directory
      if (!path.isAbsolute(directory)) return yield* refused(UNATTENDED_INVALID)
      // Folders are compared as Worktree compares them. One with no real path (a link loop) matches no listed folder.
      const folder = yield* Worktree.canonicalPath(directory)
      if (folder === undefined || !(yield* allowed(folder)))
        return yield* new ForbiddenError({ message: UNATTENDED_OFF })
      // A listed folder that is gone, or is not a folder, has its own refusal before any instance is looked for.
      if (!(yield* fs.isDir(directory))) return yield* refused(UNATTENDED_UNAVAILABLE)
      const instance = yield* loaded(folder)
      if (!instance) return yield* new ForbiddenError({ message: UNATTENDED_CLOSED })
      return yield* Effect.gen(function* () {
        if ((yield* config.trust()).trusted !== true)
          return yield* new ForbiddenError({ message: UNATTENDED_UNTRUSTED })
        return yield* mapWorktreeError(worktree.createUnattended(ctx.payload))
      }).pipe(Effect.provideService(InstanceRef, instance))
    })

    // Only the user's own config files may enable this, never a project's. They are read afresh for each request, so
    // turning it off by hand applies at once, and outside the cached copy every other reader uses, so an invalid hand
    // edit fails this read alone. Any failure to read them, an invalid file's defect included, counts as off, so a
    // refusal never carries the loader's message or the file's path. A company lock on the key also counts as off.
    const allowed = Effect.fnUntraced(function* (folder: string) {
      const global = yield* Effect.exit(config.readGlobal())
      if (Exit.isFailure(global) || Config.lockedKeys().includes("everywhere")) return false
      const block = global.value.everywhere
      if (block?.enabled !== true) return false
      const listed = yield* Effect.forEach(block.projects ?? [], (project) => Worktree.canonicalPath(project.directory))
      return listed.includes(folder)
    })

    // The instance already loaded in this engine for this folder, under any spelling, or none. Any authenticated
    // request that selects a folder loads its instance (the instance middleware), so this cannot tell an instance the
    // owner opened from one a guest's request loaded: that would need InstanceStore to record who loaded it.
    const loaded = Effect.fnUntraced(function* (folder: string) {
      const instances = yield* store.loaded()
      const folders = yield* Effect.forEach(instances, (instance) => Worktree.canonicalPath(instance.directory))
      const index = folders.indexOf(folder)
      return index === -1 ? undefined : instances[index]
    })

    return handlers.handle("unattendedPolicy", policy).handle("unattendedCreate", create)
  }),
)

function refused(message: string) {
  return new WorktreeApiError({ name: "WorktreeCreateFailedError", data: { message } })
}

// Vector everywhere's command sandbox (R-M2): whether this engine runs an unattended session's commands offline. The
// owner's question alone, refused as the worktree probe refuses.
export const unattendedShellHandlers = HttpApiBuilder.group(InstanceHttpApi, "unattended-shell", (handlers) =>
  Effect.gen(function* () {
    // The app's process service is the spawner, which owns and signals the start it tries.
    const spawner = yield* AppProcess.Service

    const policy = Effect.fn("UnattendedShellHttpApi.policy")(function* () {
      yield* requireOwner(UNATTENDED_SHELL_OWNER)
      return { shell: yield* UnattendedShell.policy(spawner) }
    })

    return handlers.handle("unattendedShell", policy)
  }),
)
