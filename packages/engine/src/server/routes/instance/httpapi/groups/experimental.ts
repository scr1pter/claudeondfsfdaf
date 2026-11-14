import { MCP } from "@/mcp"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@vectordevai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { Task } from "@vectordevai/schema/task"
import { TaskBridge } from "@vectordevai/schema/task-bridge"
import { Workflow } from "@vectordevai/schema/workflow"

export class TaskApiError extends Schema.ErrorClass<TaskApiError>("TaskApiError")(
  {
    code: Schema.Literals([
      "not_found",
      "forbidden",
      "invalid",
      "finished",
      "rate_limited",
      "limit",
      "conflict",
      "running",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

// 4.9: `disabled` names a start the owner's settings turn off (background subagents, or task/workflow denied for the
// default agent); `issues` carries the structured validation failures of an invalid start or resume.
export class WorkflowApiError extends Schema.ErrorClass<WorkflowApiError>("WorkflowApiError")(
  {
    code: Schema.Literals(["invalid", "busy", "not_found", "running", "disabled", "forbidden", "limit"]),
    message: Schema.String,
    issues: Schema.optional(Schema.Array(Workflow.Issue)),
  },
  { httpApiStatus: 400 },
) {}

export class AccountWorkApiError extends Schema.ErrorClass<AccountWorkApiError>("AccountWorkApiError")(
  { message: Schema.String }, { httpApiStatus: 400 },
) {}
export const PlaybookSelection = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^vector-[a-z0-9]+(?:-[a-z0-9]+)*$/), Schema.isMaxLength(64)),
  version: Schema.String.check(Schema.isMaxLength(32)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  replace: Schema.optional(Schema.Boolean),
})
const PlaybookEntry = Schema.Struct({
  name: Schema.String, version: Schema.String, sha256: Schema.String, installed: Schema.Boolean, current: Schema.Boolean,
})
const HostedJobLink = Schema.Struct({ id: Schema.String, title: Schema.optional(Schema.String), delivered: Schema.Boolean })

export const TaskListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  descendants: Schema.optional(QueryBoolean),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 }))),
  active: Schema.optional(QueryBoolean),
  shells: Schema.optional(QueryBoolean),
})

export const TaskMessageInput = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  delivery: Schema.optional(Schema.Literals(["steer", "queue"])),
})

export const TaskStopInput = Schema.Struct({
  taskIDs: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  all: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
})

export const TaskBackgroundInput = Schema.Struct({
  taskIDs: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(200))),
})

export const TaskResumeInput = Schema.Struct({
  taskIDs: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  text: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
})

export const TaskChangesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  diff: Schema.optional(QueryBoolean),
})

export const TaskMergeInput = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  includeStacked: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
})

export const TaskDiscardInput = Schema.Struct({
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
})

export const SessionStopInput = Schema.Struct({
  helpers: Schema.Boolean,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
})

export const TaskWaitInput = Schema.Struct({
  taskIDs: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  mode: Schema.optional(Schema.Literals(["any", "all"])),
  timeout: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 60_000 }))),
})

// A client uses a feature only when its flag is true; a missing flag means the engine lacks it. The flags expose no
// limit values.
const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
  workDelegation: Schema.optional(Schema.Boolean),
  subagentLimits: Schema.optional(Schema.Boolean),
  sessionStop: Schema.optional(Schema.Boolean),
  taskPromote: Schema.optional(Schema.Boolean),
  taskResume: Schema.optional(Schema.Boolean),
  taskAttention: Schema.optional(Schema.Boolean),
  taskIsolation: Schema.optional(Schema.Boolean),
  workflows: Schema.optional(Schema.Boolean),
  backgroundShells: Schema.optional(Schema.Boolean),
  connections: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "ExperimentalCapabilities" })

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  // Also list Vector's helper sessions (Vectorscope reviews, autocomplete), which are left out by default.
  internal: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

export const ExperimentalPaths = {
  workflowSaved: "/experimental/workflow/saved",
  playbooks: "/experimental/workflow/playbooks",
  playbookInstall: "/experimental/workflow/playbooks/install",
  hostedJobs: "/experimental/session/:sessionID/hosted-jobs",
  brainPreview: "/experimental/brain/run-bundle/preview",
  brainProposalsImport: "/experimental/brain/run-proposals/import",
  workflowValidate: "/experimental/workflow/validate",
  workflowStart: "/experimental/session/:sessionID/workflow",
  workflowList: "/experimental/session/:sessionID/workflow",
  workflowGet: "/experimental/session/:sessionID/workflow/:runID",
  workflowResume: "/experimental/session/:sessionID/workflow/:runID/resume",
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionUsage: "/experimental/session/usage",
  sessionBackground: "/experimental/session/:sessionID/background",
  sessionStop: "/experimental/session/:sessionID/stop",
  taskList: "/experimental/session/:sessionID/tasks",
  taskInspect: "/experimental/session/:sessionID/tasks/:taskID",
  taskMessage: "/experimental/session/:sessionID/tasks/:taskID/message",
  taskStop: "/experimental/session/:sessionID/tasks/stop",
  taskWait: "/experimental/session/:sessionID/tasks/wait",
  taskBackground: "/experimental/session/:sessionID/tasks/background",
  taskResume: "/experimental/session/:sessionID/tasks/resume",
  taskChanges: "/experimental/session/:sessionID/tasks/:taskID/changes",
  taskMerge: "/experimental/session/:sessionID/tasks/:taskID/merge",
  taskDiscard: "/experimental/session/:sessionID/tasks/:taskID/discard",
  taskBridgeRegister: "/experimental/session/:sessionID/tasks/bridge/register",
  taskBridgePoll: "/experimental/session/:sessionID/tasks/bridge/poll",
  taskBridgeReceipt: "/experimental/session/:sessionID/tasks/bridge/receipt",
  resource: "/experimental/resource",
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the Vector engine.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all Vector sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.get("sessionUsage", ExperimentalPaths.sessionUsage, {
          query: WorkspaceRoutingQuery,
          success: described(Session.UsageSummary, "Local token usage and activity streaks"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.usage",
            summary: "Get local token usage",
            description: "Aggregate locally persisted model usage into daily token totals and activity streaks.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.post("sessionStop", ExperimentalPaths.sessionStop, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SessionStopInput,
          success: described(Task.SessionStopResult, "What the stop reached"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.stop",
            summary: "Stop a session",
            description:
              "Stop the session's main turn and, with helpers, every subagent working under it. No new turn starts until the next user message; partial work is kept.",
          }),
        ),
        HttpApiEndpoint.get("taskList", ExperimentalPaths.taskList, {
          params: { sessionID: SessionID },
          query: TaskListQuery,
          success: described(Task.ListResult, "Session task board"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.list",
            summary: "List session tasks",
            description: "Read compact child task status and measured usage without starting model work.",
          }),
        ),
        HttpApiEndpoint.get("taskInspect", ExperimentalPaths.taskInspect, {
          params: { sessionID: SessionID, taskID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Task.InspectResult, "Bounded task progress"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.inspect",
            summary: "Inspect a session task",
            description: "Read bounded recent steps and partial output with a full-result reference.",
          }),
        ),
        HttpApiEndpoint.post("taskMessage", ExperimentalPaths.taskMessage, {
          params: { sessionID: SessionID, taskID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: TaskMessageInput,
          success: described(Task.MessageResult, "Task message receipt"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.message",
            summary: "Message a running task",
            description:
              "Admit a bounded correction for the next safe boundary; finished tasks are never restarted implicitly.",
          }),
        ),
        HttpApiEndpoint.post("taskStop", ExperimentalPaths.taskStop, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: TaskStopInput,
          success: described(Task.StopResult, "Settled tasks"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.stop",
            summary: "Stop session tasks",
            description: "Stop selected children or all children, preserving the reason and partial work.",
          }),
        ),
        HttpApiEndpoint.post("taskWait", ExperimentalPaths.taskWait, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: TaskWaitInput,
          success: described(Task.WaitResult, "Task wait result"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.wait",
            summary: "Wait for session tasks",
            description:
              "Wait for any or all selected children with a bounded timeout and no polling or model requests.",
          }),
        ),
        HttpApiEndpoint.post("taskBackground", ExperimentalPaths.taskBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          // No body moves every one.
          payload: [HttpApiSchema.NoContent, TaskBackgroundInput],
          success: described(Task.PromoteResult, "Tasks moved to the background"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.background",
            summary: "Move session tasks to the background",
            description:
              "Move the session's running foreground subagents, or the selected ones, to the background, batch entries included. Each keeps running and reports later on its own.",
          }),
        ),
        HttpApiEndpoint.post("taskResume", ExperimentalPaths.taskResume, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: TaskResumeInput,
          success: described(Task.ResumeResult, "Tasks resumed in the background"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.resume",
            summary: "Resume session tasks",
            description:
              "Continue the session's stopped, failed or interrupted subagents in the background, each in a new attempt. A completed subagent continues only with text. Nothing resumes on its own.",
          }),
        ),
        HttpApiEndpoint.get("taskChanges", ExperimentalPaths.taskChanges, {
          params: { sessionID: SessionID, taskID: Schema.String },
          query: TaskChangesQuery,
          success: described(Task.ChangesResult, "Isolated task changes"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.changes",
            summary: "Review an isolated task's changes",
            description:
              "Read an isolated child's changed files and, with diff=true, its bounded patch. Only the authenticated owner receives paths and the patch; other viewers receive counts.",
          }),
        ),
        HttpApiEndpoint.post("taskMerge", ExperimentalPaths.taskMerge, {
          params: { sessionID: SessionID, taskID: Schema.String },
          query: WorkspaceRoutingQuery,
          // No body merges every saved file, as the SDK sends it when no option is given.
          payload: [HttpApiSchema.NoContent, TaskMergeInput],
          success: described(Task.MergeResult, "Merged isolated changes"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.merge",
            summary: "Merge an isolated task",
            description:
              "Owner only. Bring an isolated child's saved changes, or the selected files, into the parent checkout after a checkpoint.",
          }),
        ),
        HttpApiEndpoint.post("taskDiscard", ExperimentalPaths.taskDiscard, {
          params: { sessionID: SessionID, taskID: Schema.String },
          query: WorkspaceRoutingQuery,
          // No body discards without a reason.
          payload: [HttpApiSchema.NoContent, TaskDiscardInput],
          success: described(Task.DiscardResult, "Discarded isolated changes"),
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.discard",
            summary: "Discard an isolated task",
            description: "Owner only. Keep a recovery artifact, then remove an isolated child's checkout and branch.",
          }),
        ),
        HttpApiEndpoint.post("taskBridgeRegister", ExperimentalPaths.taskBridgeRegister, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: TaskBridge.RegisterInput,
          success: TaskBridge.RegisterResult,
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.bridge.register",
            summary: "Register desktop task observations",
            description: "Owner-authenticated desktop relay with an expiring lease. No callback URLs are accepted.",
          }),
        ),
        HttpApiEndpoint.post("taskBridgePoll", ExperimentalPaths.taskBridgePoll, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: TaskBridge.PollInput,
          success: TaskBridge.PollResult,
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.bridge.poll",
            summary: "Wait for desktop task commands",
            description: "Owner-authenticated desktop relay with an expiring lease. No callback URLs are accepted.",
          }),
        ),
        HttpApiEndpoint.post("taskBridgeReceipt", ExperimentalPaths.taskBridgeReceipt, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: TaskBridge.ReceiptInput,
          success: TaskBridge.ReceiptResult,
          error: TaskApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.task.bridge.receipt",
            summary: "Confirm a desktop task command",
            description: "Owner-authenticated desktop relay with an expiring lease. No callback URLs are accepted.",
          }),
        ),
        HttpApiEndpoint.post("brainPreview", ExperimentalPaths.brainPreview, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ includeBrain: Schema.Literal(true), publicRepository: Schema.Boolean }),
          success: Schema.Struct({ path: Schema.Literal("brain/bundle.json"), base64url: Schema.String,
            sha256: Schema.String, bytes: NonNegativeInt, entries: NonNegativeInt, skills: NonNegativeInt }),
          error: AccountWorkApiError,
        }).annotateMerge(OpenApi.annotations({ identifier: "experimental.brain.preview", summary: "Preview explicitly selected repository Brain bytes without uploading" })),
        HttpApiEndpoint.post("brainProposalsImport", ExperimentalPaths.brainProposalsImport, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ path: Schema.Literal("brain/proposals.json"),
            base64url: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.isMaxLength(Math.ceil(512 * 1024 * 4 / 3))),
            sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)), publicRepository: Schema.Boolean }),
          success: Schema.Struct({ proposed: NonNegativeInt, known: NonNegativeInt, refused: NonNegativeInt, over: NonNegativeInt }),
          error: AccountWorkApiError,
        }).annotateMerge(OpenApi.annotations({ identifier: "experimental.brain.importProposals", summary: "Stage owner-selected returned Brain drafts for review" })),
        HttpApiEndpoint.get("playbooksList", ExperimentalPaths.playbooks, {
          query: WorkspaceRoutingQuery, success: Schema.Array(PlaybookEntry), error: AccountWorkApiError,
        }).annotateMerge(OpenApi.annotations({ identifier: "experimental.playbooks.list", summary: "List owner Playbooks for personal installation" })),
        HttpApiEndpoint.post("playbookInstall", ExperimentalPaths.playbookInstall, {
          query: WorkspaceRoutingQuery, payload: PlaybookSelection,
          success: Schema.Struct({ name: Schema.String, version: Schema.String }), error: AccountWorkApiError,
        }).annotateMerge(OpenApi.annotations({ identifier: "experimental.playbooks.install", summary: "Install a selected Playbook in owner configuration" })),
        HttpApiEndpoint.get("hostedJobs", ExperimentalPaths.hostedJobs, {
          params: { sessionID: SessionID }, query: WorkspaceRoutingQuery,
          success: Schema.Array(HostedJobLink), error: AccountWorkApiError,
        }).annotateMerge(OpenApi.annotations({ identifier: "experimental.hosted.jobs", summary: "Reconnect hosted jobs to their original owner conversation" })),
        HttpApiEndpoint.post("hostedJobAttach", ExperimentalPaths.hostedJobs, {
          params: { sessionID: SessionID }, query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ jobID: Schema.String.check(Schema.isPattern(/^(?:jb|jr)_[a-z2-7]{26}$/)) }),
          success: HostedJobLink, error: AccountWorkApiError,
        }).annotateMerge(OpenApi.annotations({ identifier: "experimental.hosted.attach", summary: "Return a current-account hosted job report to this owner conversation" })),
        HttpApiEndpoint.get("workflowSaved", ExperimentalPaths.workflowSaved, {
          query: WorkspaceRoutingQuery,
          success: Workflow.SavedList,
          error: WorkflowApiError,
        }).annotateMerge(
          OpenApi.annotations({ identifier: "experimental.workflow.saved", summary: "List trusted saved workflows" }),
        ),
        HttpApiEndpoint.post("workflowValidate", ExperimentalPaths.workflowValidate, {
          query: WorkspaceRoutingQuery,
          success: Workflow.Validation,
          error: WorkflowApiError,
          payload: Workflow.ValidateInput,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workflow.validate",
            summary: "Validate a workflow without starting it",
          }),
        ),
        HttpApiEndpoint.post("workflowStart", ExperimentalPaths.workflowStart, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: Workflow.Started,
          error: WorkflowApiError,
          payload: Workflow.StartInput,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workflow.start",
            summary: "Start an owner-approved workflow",
          }),
        ),
        HttpApiEndpoint.get("workflowList", ExperimentalPaths.workflowList, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: Workflow.RunList,
          error: WorkflowApiError,
        }).annotateMerge(
          OpenApi.annotations({ identifier: "experimental.workflow.list", summary: "List workflow runs" }),
        ),
        HttpApiEndpoint.get("workflowGet", ExperimentalPaths.workflowGet, {
          params: { sessionID: SessionID, runID: SessionID },
          query: WorkspaceRoutingQuery,
          success: Workflow.RunDetail,
          error: WorkflowApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workflow.get",
            summary: "Get workflow progress and results",
          }),
        ),
        HttpApiEndpoint.post("workflowResume", ExperimentalPaths.workflowResume, {
          params: { sessionID: SessionID, runID: SessionID },
          query: WorkspaceRoutingQuery,
          success: Workflow.Started,
          error: WorkflowApiError,
          payload: [HttpApiSchema.NoContent, Workflow.ResumeInput],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workflow.resume",
            summary: "Resume an owner-approved workflow",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "vector experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
