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
  controls: Schema.Struct({ inspect: Schema.Boolean, message: Schema.Boolean, stop: Schema.Boolean }),
}).annotate({ identifier: "Task.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const ListResult = Schema.Struct({ tasks: Schema.Array(Info), truncated: Schema.Boolean }).annotate({
  identifier: "Task.ListResult",
})
export interface ListResult extends Schema.Schema.Type<typeof ListResult> {}

export const InspectResult = Schema.Struct({
  task: Info,
  steps: Schema.Array(
    Schema.Struct({ tool: optional(Schema.String), status: optional(Schema.String), text: Schema.String }),
  ),
  output: Schema.String,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Task.InspectResult" })
export interface InspectResult extends Schema.Schema.Type<typeof InspectResult> {}

export const MessageResult = Schema.Struct({
  taskID: Schema.String,
  messageID: Schema.String,
  delivery: Schema.Literals(["steer", "queue"]),
  accepted: Schema.Literal(true),
}).annotate({ identifier: "Task.MessageResult" })
export interface MessageResult extends Schema.Schema.Type<typeof MessageResult> {}

export const StopResult = Schema.Struct({ tasks: Schema.Array(Info) }).annotate({ identifier: "Task.StopResult" })
export interface StopResult extends Schema.Schema.Type<typeof StopResult> {}

export const WaitResult = Schema.Struct({ tasks: Schema.Array(Info), timedOut: Schema.Boolean }).annotate({
  identifier: "Task.WaitResult",
})
export interface WaitResult extends Schema.Schema.Type<typeof WaitResult> {}
