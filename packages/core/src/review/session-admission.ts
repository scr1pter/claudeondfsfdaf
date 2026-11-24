// The V2 session API's hold on review sessions (scope-finish takeover, after VS-23d). Only the engine's V1 routes hold a
// `vectorscope.*` session's model calls to its review's privacy (ReviewRoutes): the V2 runner sends through
// @vectordevai/llm, which nothing there holds. So the server package refuses a V2 prompt, resume or compaction of such a
// session while its review policy is "zdr". The engine gives the policy through this port; a host without it is
// treated as "zdr", since the policy cannot be read there.
import { Context, Effect } from "effect"

export interface Interface {
  /** Whether this review session's model calls must stay on a zero data retention route. */
  readonly zdr: (sessionID: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ReviewSessionAdmission") {}

export const ZDR_METADATA = "vector.review.zdr"
export const ZDR_METADATA_PATH = `$."${ZDR_METADATA}"`

export const REFUSAL =
  "This review session runs under zero data retention, which this session API cannot hold to. Nothing was sent."

export function isReviewSession(internal: string | undefined) {
  return internal?.startsWith("vectorscope.") === true
}

export * as ReviewSessionAdmission from "./session-admission"
