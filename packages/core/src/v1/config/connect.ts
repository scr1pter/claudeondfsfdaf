export * as ConfigConnectV1 from "./connect"

import { Schema } from "effect"

export const AfterRun = Schema.Literals(["off", "report", "repair"])
export const BeforeCommit = Schema.Literals(["off", "offer", "run"])

export const Review = Schema.Struct({
  after_run: Schema.optional(AfterRun).annotate({
    description: "Review changed files after a run: off (default), report, or repair.",
  }),
  before_commit: Schema.optional(BeforeCommit).annotate({
    description:
      "Before a commit, push or PR: off, offer (default), or run a review. This is guidance, not a commit guard.",
  }),
  max_rounds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))).annotate({
    description: "Review rounds per user request (default: 1).",
  }),
  max_cost_usd: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({
    description: "Maximum dollars for one review, further limited by the conversation's budget (default: 2).",
  }),
}).annotate({ identifier: "ConnectReviewConfig" })

export const Info = Schema.Struct({ review: Schema.optional(Review) }).annotate({ identifier: "ConnectConfig" })
export type Info = typeof Info.Type

export const Defaults = { after_run: "off", before_commit: "offer", max_rounds: 1, max_cost_usd: 2 } as const

export function review(config?: Info) {
  return { ...Defaults, ...config?.review }
}
