export * as ReviewRun from "./review-run"

import { Schema } from "effect"
import { optional } from "./schema"

// Public local requests select work to review, never the helper's authority,
// placement, instructions, model options, or publication policy. Remote PR
// snapshots need their own verified source contract before using this route.
export const Start = Schema.Struct({
  requestID: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,128}$/)),
  target: Schema.Struct({
    kind: Schema.Literals(["working-tree", "staged"]),
    head: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)),
  }),
  maxCost: optional(Schema.Finite.check(Schema.isGreaterThan(0))),
}).annotate({ identifier: "ReviewRun.Start" })
export interface Start extends Schema.Schema.Type<typeof Start> {}
