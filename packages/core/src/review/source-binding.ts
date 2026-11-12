export * as ReviewSourceBinding from "./source-binding"

import { Schema } from "effect"

const location = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)[^\0\r\n]*$/),
)
const identity = Schema.Struct({
  dev: Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]{0,29})$/)),
  ino: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,29}$/)),
  birth: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,29}$/)),
}).annotate({ parseOptions: { onExcessProperty: "error" } })

export const MarkerID = Schema.String.check(Schema.isPattern(/^vrw1_[0-9a-f]{32}$/))
export const Witnesses = Schema.Struct({
  version: Schema.Literal(1),
  parent: MarkerID,
  review: MarkerID,
})
  .check(Schema.makeFilter((value) => value.parent !== value.review))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
export type Witnesses = typeof Witnesses.Type

/** Private winning-reservation data, never accepted by the public review Start schema. */
export const Info = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String.check(Schema.isPattern(/^vrs1_[0-9a-f]{64}$/)),
  directory: location,
  worktree: location,
  gitDirectory: location,
  commonDirectory: location,
  commonIdentity: identity,
  // Absent on legacy reservations; retries never add registration authority.
  witnesses: Schema.optional(Witnesses),
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export type Info = typeof Info.Type
