export * as Task from "./task"

import { Schema } from "effect"
import { optional } from "./schema"
import { RunBudget } from "./run-budget"
import { Billing } from "./billing"

export const Status = Schema.Literals([
  "queued",
  "running",
  "waiting_on_user",
  "completed",
  "failed",
  "stopped",
]).annotate({ identifier: "Task.Status" })
export type Status = typeof Status.Type

export const Usage = Schema.Struct({
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
  }),
  total: Schema.Finite,
  toolUses: Schema.Finite,
  steps: Schema.Finite,
  unpricedSteps: optional(Schema.Finite),
  // How many of those unpriced steps ran on Vector Codium, as in the session totals.
  codiumSteps: optional(Schema.Finite),
  // Proof for the token aggregate this task exposes, including any descendants in that aggregate.
  tokensOwnOnly: optional(Schema.Boolean),
}).annotate({ identifier: "Task.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const BudgetScope = Schema.Struct({
  kind: Schema.Literals(["run", "batch", "child"]),
  id: Schema.String,
  budget: RunBudget.Info,
  spentUsd: Schema.Finite,
  steps: Schema.Finite,
  unpricedSteps: Schema.Finite,
  // Steps that ran on Vector Codium. The guard counts them apart: its unpricedSteps counts only unknown steps.
  codiumSteps: optional(Schema.Finite),
  costKind: optional(RunBudget.CostKind),
  stopped: optional(Schema.Struct({ reason: RunBudget.StopReason, message: Schema.String })),
}).annotate({ identifier: "Task.BudgetScope" })
export interface BudgetScope extends Schema.Schema.Type<typeof BudgetScope> {}

// The additions below are all optional, so a payload from an earlier version decodes. Enums nested in them are
// strings, with their known values in a comment, so a desktop bridge payload with an unknown value still decodes.

export const Model = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: optional(Schema.String),
}).annotate({ identifier: "Task.Model" })
export interface Model extends Schema.Schema.Type<typeof Model> {}

// A helper a shutdown, crash or instance disposal stopped. It is never resumed automatically.
export const Interrupted = Schema.Struct({
  at: Schema.Finite,
  cause: Schema.String, // shutdown | crash | disposed | unknown
  reported: optional(Schema.Boolean),
  resumedAt: optional(Schema.Finite),
  dismissedAt: optional(Schema.Finite),
}).annotate({ identifier: "Task.Interrupted" })
export interface Interrupted extends Schema.Schema.Type<typeof Interrupted> {}

// A helper blocked on a permission or a question for the user.
export const Waiting = Schema.Struct({
  kind: Schema.String, // permission | question
  since: Schema.Finite,
  requestID: optional(Schema.String),
  expiresAt: optional(Schema.Finite),
  summary: optional(Schema.String), // at most 200 characters, clamped by the producer
}).annotate({ identifier: "Task.Waiting" })
export interface Waiting extends Schema.Schema.Type<typeof Waiting> {}

export const Result = Schema.Struct({
  format: Schema.String, // text | json
  valid: optional(Schema.Boolean),
  attempts: optional(Schema.Finite),
}).annotate({ identifier: "Task.Result" })
export interface Result extends Schema.Schema.Type<typeof Result> {}

// A helper's own worktree or copy. Paths and detailed artifacts are sent only to the authenticated owner.
export const Isolation = Schema.Struct({
  mode: Schema.String, // worktree | copy
  state: Schema.String, // preparing | active | settling | unchanged | changed | merged | discarded | diverged | failed
  branch: optional(Schema.String),
  directory: optional(Schema.String),
  files: optional(Schema.Finite),
  additions: optional(Schema.Finite),
  deletions: optional(Schema.Finite),
  merged: optional(Schema.Array(Schema.String)),
  skipped: optional(Schema.Array(Schema.String)),
  conflicts: optional(Schema.Array(Schema.String)), // at most 50
  error: optional(Schema.String),
}).annotate({ identifier: "Task.Isolation" })
export interface Isolation extends Schema.Schema.Type<typeof Isolation> {}

export const WorkflowStage = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  phase: Schema.String,
  total: optional(Schema.Finite),
  done: Schema.Finite,
  failed: Schema.Finite,
  skipped: Schema.Finite,
  running: Schema.Finite,
  waiting: Schema.Finite,
}).annotate({ identifier: "Task.WorkflowStage" })
export interface WorkflowStage extends Schema.Schema.Type<typeof WorkflowStage> {}

// A workflow run, or one agent of a run.
export const Workflow = Schema.Struct({
  role: Schema.String, // run | agent
  runID: Schema.String,
  title: optional(Schema.String),
  stage: optional(Schema.String),
  phase: optional(Schema.String),
  item: optional(Schema.String),
  round: optional(Schema.Finite),
  verified: optional(Schema.Boolean),
  stages: optional(Schema.Array(WorkflowStage)),
  agents: optional(Schema.Struct({ launched: Schema.Finite, max: Schema.Finite, running: Schema.Finite })),
  tokens: optional(Schema.Struct({ used: Schema.Finite, max: optional(Schema.Finite) })),
  stop: optional(Schema.Struct({ reason: Schema.String, message: Schema.String })),
}).annotate({ identifier: "Task.Workflow" })
export interface Workflow extends Schema.Schema.Type<typeof Workflow> {}

// A conversation's subagent limits and the current request's delegated spend. A spend with unknown steps is
// unknown, never $0.
export const Limits = Schema.Struct({
  running: Schema.Finite,
  queued: Schema.Finite,
  maxRunning: Schema.Finite,
  launched: Schema.Finite,
  maxPerRequest: Schema.Finite,
  spend: optional(
    Schema.Struct({
      spentUsd: Schema.Finite,
      limitUsd: optional(Schema.Finite),
      unknownSteps: Schema.Finite,
      warned: Schema.Boolean,
      stopped: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: "Task.Limits" })
export interface Limits extends Schema.Schema.Type<typeof Limits> {}

export const Message = Schema.Struct({
  id: Schema.String,
  direction: Schema.String, // to_task | to_parent
  sender: Schema.String, // user | parent | peer | task
  text: Schema.String, // at most 4096 characters
  createdAt: Schema.Finite,
  deliveredAt: optional(Schema.Finite),
}).annotate({ identifier: "Task.Message" })
export interface Message extends Schema.Schema.Type<typeof Message> {}

// A background shell command. `outputPath` is sent only to the owner.
export const Shell = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  command: Schema.String, // at most 500 characters
  status: Schema.String, // running | completed | failed | stopped | interrupted
  startedAt: Schema.Finite,
  completedAt: optional(Schema.Finite),
  exitCode: optional(Schema.Finite),
  outputPath: optional(Schema.String),
  outputBytes: Schema.Finite,
}).annotate({ identifier: "Task.Shell" })
export interface Shell extends Schema.Schema.Type<typeof Shell> {}

export const Info = Schema.Struct({
  id: Schema.String,
  sessionID: optional(Schema.String),
  parentSessionID: Schema.String,
  source: Schema.Literals(["subagent", "team", "swarm", "external"]),
  title: Schema.String,
  agent: optional(Schema.String),
  status: Status,
  // A disconnected runner may still be executing. Preserve its last observed
  // status and disable live controls rather than inventing completion.
  connection: optional(Schema.Literals(["connected", "disconnected"])),
  batchID: optional(Schema.String),
  groupID: optional(Schema.String),
  startedAt: Schema.Finite,
  completedAt: optional(Schema.Finite),
  elapsedMs: Schema.Finite,
  currentStep: optional(Schema.String),
  lastTool: optional(Schema.String),
  usage: optional(Usage),
  // External runtimes may report dollars without a token breakdown. Missing
  // usage stays unknown; a measured cost must not synthesize zero token counts.
  measuredCost: optional(Schema.Finite),
  costKind: optional(RunBudget.CostKind),
  // Codium participated even when a desktop runner has no token breakdown. costKind still describes own spend.
  billing: optional(Billing.Kind),
  ownedPaths: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
  resultAvailable: Schema.Boolean,
  resultRef: optional(Schema.String),
  reason: optional(Schema.String),
  attempt: Schema.Finite,
  budget: optional(RunBudget.Info),
  budgetScopes: optional(Schema.Array(BudgetScope)),
  controls: Schema.Struct({
    inspect: Schema.Boolean,
    message: Schema.Boolean,
    stop: Schema.Boolean,
    resume: optional(Schema.Boolean),
    background: optional(Schema.Boolean),
    merge: optional(Schema.Boolean),
    discard: optional(Schema.Boolean),
  }),
  model: optional(Model),
  effort: optional(Schema.String), // default | low | medium | high
  background: optional(Schema.Boolean),
  fork: optional(Schema.Boolean),
  queuedReason: optional(Schema.String),
  interrupted: optional(Interrupted),
  waiting: optional(Waiting),
  result: optional(Result),
  isolation: optional(Isolation),
  workflow: optional(Workflow),
  inbox: optional(Schema.Struct({ unread: Schema.Finite })),
}).annotate({ identifier: "Task.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const ListResult = Schema.Struct({
  tasks: Schema.Array(Info),
  truncated: Schema.Boolean,
  limits: optional(Limits),
  shells: optional(Schema.Array(Shell)),
}).annotate({ identifier: "Task.ListResult" })
export interface ListResult extends Schema.Schema.Type<typeof ListResult> {}

export const InspectResult = Schema.Struct({
  task: Info,
  steps: Schema.Array(
    Schema.Struct({ tool: optional(Schema.String), status: optional(Schema.String), text: Schema.String }),
  ),
  output: Schema.String,
  truncated: Schema.Boolean,
  messages: optional(Schema.Array(Message)), // at most 50
  // A structured result as pretty JSON of at most 8 KiB.
  structured: optional(Schema.Struct({ json: Schema.String, valid: Schema.Boolean, truncated: Schema.Boolean })),
}).annotate({ identifier: "Task.InspectResult" })
export interface InspectResult extends Schema.Schema.Type<typeof InspectResult> {}

export const MessageResult = Schema.Struct({
  taskID: Schema.String,
  messageID: Schema.String,
  delivery: Schema.Literals(["steer", "queue"]),
  accepted: Schema.Literal(true),
}).annotate({ identifier: "Task.MessageResult" })
export interface MessageResult extends Schema.Schema.Type<typeof MessageResult> {}

// `shells` only when the request named background commands (`shl_…`); they are never shown as tasks.
export const StopResult = Schema.Struct({
  tasks: Schema.Array(Info),
  shells: optional(Schema.Array(Shell)),
}).annotate({ identifier: "Task.StopResult" })
export interface StopResult extends Schema.Schema.Type<typeof StopResult> {}

export const WaitResult = Schema.Struct({
  tasks: Schema.Array(Info),
  timedOut: Schema.Boolean,
  attention: optional(Schema.Array(Schema.String)),
  // Only when the request named background commands (`shl_…`).
  shells: optional(Schema.Array(Shell)),
}).annotate({ identifier: "Task.WaitResult" })
export interface WaitResult extends Schema.Schema.Type<typeof WaitResult> {}

export const SessionStopResult = Schema.Struct({
  aborted: Schema.Boolean,
  tasks: Schema.Array(Info),
  shells: Schema.Finite,
  excluded: Schema.Finite,
  skipped: Schema.Finite,
}).annotate({ identifier: "Task.SessionStopResult" })
export interface SessionStopResult extends Schema.Schema.Type<typeof SessionStopResult> {}

export const ResumeResult = Schema.Struct({ tasks: Schema.Array(Info) }).annotate({ identifier: "Task.ResumeResult" })
export interface ResumeResult extends Schema.Schema.Type<typeof ResumeResult> {}

export const PromoteResult = Schema.Struct({ tasks: Schema.Array(Info) }).annotate({ identifier: "Task.PromoteResult" })
export interface PromoteResult extends Schema.Schema.Type<typeof PromoteResult> {}

export const ChangedFile = Schema.Struct({
  path: Schema.String,
  status: Schema.String, // added | modified | deleted
  additions: Schema.Finite,
  deletions: Schema.Finite,
  binary: Schema.Boolean,
}).annotate({ identifier: "Task.ChangedFile" })
export interface ChangedFile extends Schema.Schema.Type<typeof ChangedFile> {}

export const ChangesResult = Schema.Struct({
  task: Info,
  files: Schema.Array(ChangedFile),
  patch: optional(Schema.String), // at most 256 KiB, sent only to the authenticated owner
  truncated: Schema.Boolean,
  mergeable: Schema.String, // clean | conflict | blocked | unknown
  detail: optional(Schema.String),
}).annotate({ identifier: "Task.ChangesResult" })
export interface ChangesResult extends Schema.Schema.Type<typeof ChangesResult> {}

export const MergeResult = Schema.Struct({
  task: Info,
  merged: Schema.Array(Schema.String),
  remaining: Schema.Array(Schema.String),
  conflicts: Schema.Array(Schema.String),
  checkpoint: optional(Schema.String),
}).annotate({ identifier: "Task.MergeResult" })
export interface MergeResult extends Schema.Schema.Type<typeof MergeResult> {}

export const DiscardResult = Schema.Struct({ task: Info, saved: optional(Schema.String) }).annotate({
  identifier: "Task.DiscardResult",
})
export interface DiscardResult extends Schema.Schema.Type<typeof DiscardResult> {}

export const ReportResult = Schema.Struct({
  taskID: Schema.String,
  parentSessionID: Schema.String,
  woke: Schema.Boolean,
  at: Schema.Finite,
}).annotate({ identifier: "Task.ReportResult" })
export interface ReportResult extends Schema.Schema.Type<typeof ReportResult> {}
