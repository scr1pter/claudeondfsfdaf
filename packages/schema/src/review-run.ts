export * as ReviewRun from "./review-run"

import { Schema, Struct } from "effect"
import { NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"

// Public local requests select work to review, never the helper's authority,
// placement, instructions, model options, or publication policy. Remote PR
// snapshots need their own verified source contract before using this route.
export const Target = Schema.Struct({
  kind: Schema.Literals(["working-tree", "staged"]),
  head: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
}).annotate({ identifier: "ReviewRun.Target", parseOptions: { onExcessProperty: "error" } })
export interface Target extends Schema.Schema.Type<typeof Target> {}

export const Start = Schema.Struct({
  requestID: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,128}$/)),
  target: Target,
  maxCost: optional(Schema.Finite.check(Schema.isGreaterThan(0))),
}).annotate({ identifier: "ReviewRun.Start", parseOptions: { onExcessProperty: "error" } })
export interface Start extends Schema.Schema.Type<typeof Start> {}

export const RESULT_BYTES = 8 * 1024 * 1024

// The shared runner's exact serialized result, not another selection pass. The
// desktop must verify and decode this versioned artifact before presentation;
// no field in it grants execution, posting, or continuation authority.
export const Artifact = Schema.Struct({
  version: Schema.Literal(1),
  json: Schema.String.check(Schema.isMaxLength(RESULT_BYTES)),
  bytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(RESULT_BYTES)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
}).annotate({ identifier: "ReviewRun.Artifact" })
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

export const Status = Schema.Literals([
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]).annotate({ identifier: "ReviewRun.Status" })
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  runID: SessionID,
  parentID: SessionID,
  request: Start,
  status: Status,
  canStop: Schema.Boolean,
  startedAt: NonNegativeInt,
  completedAt: optional(NonNegativeInt),
  artifact: optional(Artifact),
  error: optional(Schema.String.check(Schema.isMaxLength(2048))),
}).annotate({ identifier: "ReviewRun.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

// A discovery page carries execution status only. The exact owned run must be
// fetched separately before its result can be decoded or shown as reviewed.
export const Summary = Schema.Struct({
  ...Struct.omit(Info.fields, ["artifact"]),
  hasResult: Schema.Boolean,
}).annotate({ identifier: "ReviewRun.Summary", parseOptions: { onExcessProperty: "error" } })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

export const List = Schema.Struct({
  runs: Schema.Array(Summary).check(Schema.isMaxLength(50)),
  next: optional(SessionID),
}).annotate({ identifier: "ReviewRun.List" })
export interface List extends Schema.Schema.Type<typeof List> {}

export const ListInput = Schema.Struct({
  cursor: optional(SessionID),
  limit: optional(NonNegativeInt.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
}).annotate({ identifier: "ReviewRun.ListInput", parseOptions: { onExcessProperty: "error" } })
export interface ListInput extends Schema.Schema.Type<typeof ListInput> {}
