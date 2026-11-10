export * as SessionStatusEvent from "./session-status-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { RunBudget } from "./run-budget"
import { SessionID } from "./session-id"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Status = Event.define({
  type: "session.status",
  schema: {
    sessionID: SessionID,
    status: Info,
  },
})

// deprecated
export const Idle = Event.define({
  type: "session.idle",
  schema: {
    sessionID: SessionID,
  },
})

// What a run has spent, published after every guarded step. `sessionID` is the root session of the run.
export const Spend = Event.define({
  type: "session.spend",
  schema: {
    sessionID: SessionID,
    state: Schema.Literals(["ok", "warn", "stopped"]),
    reason: optional(RunBudget.StopReason),
    message: optional(Schema.String),
    spentUsd: Schema.Finite,
    capUsd: optional(Schema.Finite),
    steps: NonNegativeInt,
    unpricedSteps: NonNegativeInt,
    // Steps that ran on Vector Codium. The guard counts them apart: its unpricedSteps counts only unknown steps.
    codiumSteps: optional(NonNegativeInt),
    costKind: RunBudget.CostKind,
    estimate: optional(Schema.Struct({ lowUsd: Schema.Finite, highUsd: Schema.Finite })),
  },
})

export const Definitions = Event.inventory(Status, Idle, Spend)
