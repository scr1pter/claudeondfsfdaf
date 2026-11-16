export * as ReviewMemoryConsent from "./memory-consent"

import { Context, Effect } from "effect"
import type { ReviewMemory } from "@vectordevai/core/brain/review-memory"

/** Derived by the authenticated Engine adapter; never deserialized from a request. */
export interface Actor {
  readonly principal: string
  readonly repository: string
  readonly scope: string
  readonly key: string
}

export interface Port {
  readonly authorize: <A>(
    request: ReviewMemory.OwnerRequest,
    actor: Actor,
    use: () => Effect.Effect<ReviewMemory.Result<A>>,
  ) => Effect.Effect<ReviewMemory.Result<A>>
}

// Only the prepared owner service supplies this private request-scoped port.
// A JSON owner/approved flag and ordinary authenticated reads cannot create it.
export const Current = Context.Reference<Port | undefined>("@vector/ReviewMemoryConsent", {
  defaultValue: () => undefined,
})
