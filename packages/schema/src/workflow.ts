export * as Workflow from "./workflow"

import { Schema } from "effect"
import { NonNegativeInt, optional, PositiveInt } from "./schema"
import { Task } from "./task"

export const Issue = Schema.Struct({ path: Schema.String, message: Schema.String }).annotate({
  identifier: "Workflow.Issue",
})
export interface Issue extends Schema.Schema.Type<typeof Issue> {}

const PlanStageFields = {
  id: Schema.String,
  title: Schema.String,
  phase: Schema.String,
  items: Schema.Union([NonNegativeInt, Schema.Literal("dynamic")]),
  serial: Schema.Boolean,
  writes: Schema.String,
  asks: Schema.Array(Schema.String),
}

export const PlanAgentStage = Schema.Struct({
  ...PlanStageFields,
  kind: optional(Schema.Literal("agent")),
  agent: Schema.String,
  model: optional(Schema.String),
  effort: optional(Schema.String),
  isolation: optional(Schema.String),
  verify: optional(Schema.Struct({ agent: Schema.String, maxRounds: PositiveInt })),
}).annotate({ identifier: "Workflow.PlanAgentStage" })
export interface PlanAgentStage extends Schema.Schema.Type<typeof PlanAgentStage> {}

export const PlanConnectStage = Schema.Struct({
  ...PlanStageFields,
  kind: Schema.Literal("connect"),
  connect: Schema.Struct({ to: Schema.String, action: Schema.String }),
}).annotate({ identifier: "Workflow.PlanConnectStage" })
export interface PlanConnectStage extends Schema.Schema.Type<typeof PlanConnectStage> {}

export const PlanStage = Schema.Union([PlanAgentStage, PlanConnectStage]).annotate({ identifier: "Workflow.PlanStage" })
export type PlanStage = typeof PlanStage.Type

export const Plan = Schema.Struct({
  title: Schema.String,
  stages: Schema.Array(PlanStage),
  maxAgents: PositiveInt,
  concurrency: PositiveInt,
  usd: optional(Schema.Finite),
  tokens: optional(PositiveInt),
  steps: PositiveInt,
  perAgentSteps: PositiveInt,
  minutes: PositiveInt,
  saved: optional(Schema.Struct({ name: Schema.String, source: Schema.Literals(["repository", "user"]) })),
}).annotate({ identifier: "Workflow.Plan" })
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

export const Saved = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  description: optional(Schema.String),
  source: Schema.Literals(["repository", "user"]),
  inputs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: optional(Schema.String),
      required: Schema.Boolean,
      default: optional(Schema.Json),
    }),
  ),
  issues: optional(Schema.Array(Issue)),
}).annotate({ identifier: "Workflow.Saved" })
export interface Saved extends Schema.Schema.Type<typeof Saved> {}

export const SavedList = Schema.Struct({ workflows: Schema.Array(Saved) }).annotate({
  identifier: "Workflow.SavedList",
})
export interface SavedList extends Schema.Schema.Type<typeof SavedList> {}

const byteBound = (max: number) =>
  Schema.String.check(
    Schema.isMaxLength(max),
    Schema.makeFilter((value: string) => new TextEncoder().encode(value).byteLength <= max, {
      description: `At most ${max} UTF-8 bytes.`,
    }),
  )

const InputFields = {
  spec: optional(Schema.String),
  name: optional(Schema.String),
  inputs: optional(Schema.Record(Schema.String, Schema.Json)),
}

export const ValidateInput = Schema.Struct(InputFields).annotate({ identifier: "Workflow.ValidateInput" })
export interface ValidateInput extends Schema.Schema.Type<typeof ValidateInput> {}

export const Validation = Schema.Struct({
  ok: Schema.Boolean,
  issues: Schema.Array(Issue),
  warnings: Schema.Array(Issue),
  plan: optional(Plan),
}).annotate({ identifier: "Workflow.Validation" })
export interface Validation extends Schema.Schema.Type<typeof Validation> {}

export const StartInput = Schema.Struct({
  ...InputFields,
  title: optional(Schema.String),
  quiet: optional(Schema.Boolean),
}).annotate({ identifier: "Workflow.StartInput" })
export interface StartInput extends Schema.Schema.Type<typeof StartInput> {}

export const ResumeInput = Schema.Struct({
  spec: InputFields.spec,
  inputs: InputFields.inputs,
  retryFailed: optional(Schema.Boolean),
}).annotate({ identifier: "Workflow.ResumeInput" })
export interface ResumeInput extends Schema.Schema.Type<typeof ResumeInput> {}

export const Started = Schema.Struct({ runID: Schema.String, title: Schema.String, plan: Plan }).annotate({
  identifier: "Workflow.Started",
})
export interface Started extends Schema.Schema.Type<typeof Started> {}

export const Node = Schema.Struct({
  key: Schema.String,
  stage: Schema.String,
  phase: Schema.String,
  item: Schema.String,
  status: Schema.String,
  sessionID: optional(Schema.String),
  round: optional(NonNegativeInt),
  verified: optional(Schema.Boolean),
  error: optional(byteBound(1024)),
  preview: optional(byteBound(2048)),
}).annotate({ identifier: "Workflow.Node" })
export interface Node extends Schema.Schema.Type<typeof Node> {}

export const RunList = Schema.Struct({ runs: Schema.Array(Task.Info) }).annotate({ identifier: "Workflow.RunList" })
export interface RunList extends Schema.Schema.Type<typeof RunList> {}

export const RunDetail = Schema.Struct({
  task: Task.Info,
  spec: optional(Schema.String),
  nodes: Schema.Array(Node).check(Schema.isMaxLength(500)),
  truncated: Schema.Boolean,
  report: optional(byteBound(64 * 1024)),
  results: optional(Schema.Json),
}).annotate({ identifier: "Workflow.RunDetail" })
export interface RunDetail extends Schema.Schema.Type<typeof RunDetail> {}
