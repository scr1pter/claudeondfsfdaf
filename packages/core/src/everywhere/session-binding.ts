export * as EverywhereSessionWire from "./session-binding"

import { Schema } from "effect"
import { BRANCH_PATTERN, HEAD_SHA_PATTERN, JOB_ID_PATTERN, PLATFORMS } from "@vectordevai/schema/everywhere"
import { PermissionV1 } from "@vectordevai/schema/permission-v1"

const fields = {
  jid: Schema.String.check(Schema.isPattern(JOB_ID_PATTERN)),
  directory: Schema.String,
  branch: Schema.String.check(Schema.isPattern(BRANCH_PATTERN)),
  base: Schema.String.check(Schema.isPattern(HEAD_SHA_PATTERN)),
}

export const Placement = Schema.Struct(fields)
export type Placement = typeof Placement.Type

export const Request = Schema.Struct({
  ...fields,
  version: Schema.Literal(1),
  claim: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  platform: Schema.Literals(PLATFORMS),
  title: Schema.String.check(Schema.isMaxLength(512)),
  permission: PermissionV1.Ruleset,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export type Request = typeof Request.Type

export const SessionID = Schema.String.check(Schema.isPattern(/^ses[A-Za-z0-9_]+$/))
export const Result = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("created"), sessionID: SessionID }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literals(["refused", "unavailable", "unsupported"]) }),
])
export type Result = typeof Result.Type
