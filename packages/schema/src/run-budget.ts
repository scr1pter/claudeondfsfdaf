export * as RunBudget from "./run-budget"

import { Schema } from "effect"
import { NonNegativeInt, optional, PositiveInt } from "./schema"
import { SessionID } from "./session-id"

// Limits for one run of a root session and its subagents. `usd` is priced at catalog list rates; `warnAt` is the
// share of `usd` at which the run warns once; `unpricedSteps` bounds steps on a model with no catalog price.
export const Info = Schema.Struct({
  usd: optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  steps: optional(PositiveInt),
  warnAt: optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  unpricedSteps: optional(PositiveInt),
}).annotate({ identifier: "RunBudget" })
export type Info = Schema.Schema.Type<typeof Info>

export const StopReason = Schema.Literals(["cap", "predicted", "unpriced", "steps", "loop"]).annotate({
  identifier: "RunBudgetStopReason",
})
export type StopReason = typeof StopReason.Type

// How a model's steps are billed: priced at catalog list rates, free, covered by a subscription plan, local (a model
// server on this computer or a listed private address, with no price configured), unknown because the catalog
// has no price, or codium: billed to the account's Vector Codium plan on vectordev.ai and never priced locally.
// Vectorscope and the run guard share it.
export const CostKind = Schema.Literals(["free", "priced", "plan", "local", "unknown", "codium"]).annotate({
  identifier: "CostKind",
})
export type CostKind = typeof CostKind.Type

// What the run of a root session has spent so far, or what its last finished run spent. `sessionID` is the root.
export const Snapshot = Schema.Struct({
  sessionID: SessionID,
  state: Schema.Literals(["ok", "warn", "stopped"]),
  reason: optional(StopReason),
  message: optional(Schema.String),
  budget: Info,
  spentUsd: Schema.Finite,
  steps: NonNegativeInt,
  unpricedSteps: NonNegativeInt,
  // Steps that ran on Vector Codium. The guard counts them apart: its unpricedSteps counts only unknown steps.
  codiumSteps: optional(NonNegativeInt),
  costKind: optional(CostKind),
}).annotate({ identifier: "SpendSnapshot" })
export type Snapshot = Schema.Schema.Type<typeof Snapshot>
