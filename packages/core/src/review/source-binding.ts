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

/** Private winning-reservation data, never accepted by the public review Start schema. */
export const Info = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String.check(Schema.isPattern(/^vrs1_[0-9a-f]{64}$/)),
  directory: location,
  worktree: location,
  gitDirectory: location,
  commonDirectory: location,
  commonIdentity: identity,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export type Info = typeof Info.Type
