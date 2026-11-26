import { Context } from "effect"
import type { Usage } from "@vectordevai/llm"
import type { Provider } from "@/provider/provider"
import type { MessageID, SessionID } from "./schema"

export interface Settlement {
  readonly usage?: Usage
  readonly cost: number
  readonly context: number
  readonly cached: number
  readonly complete: boolean
}

/** The first admitted provider request can be compared with its dispatch reservation once it has been prepared. */
export interface ReviewFirstRequest {
  readonly maxTokens: number
  readonly checked: (tokens: number | undefined) => void
}

export class ReviewFirstRequestBudget extends Error {
  constructor() {
    super("The complete first review request no longer fits its reserved input budget.")
    this.name = "ReviewFirstRequestBudget"
  }
}

export interface Lease {
  readonly reviewFirstRequest?: ReviewFirstRequest
  readonly tools?: readonly string[]
  // Cumulative known cost can exceed its estimate before the attempt finishes persisting its response.
  // Observation must not release a reservation or count the same cost again at settlement.
  readonly observe?: (cost: number) => void
  readonly settle: (result: Settlement) => void
}

export interface Policy {
  readonly sessionID: SessionID
  // Synchronous admission and settlement keep shared reservations atomic across parallel session fibers.
  // An admitted invocation may fail before the transport sends it; incomplete usage remains conservative.
  readonly admit: (input: {
    messageID: MessageID
    model: Provider.Model
    tools: readonly string[]
  }) => Lease | undefined
}

// Internal, scoped to the owning prompt fiber. Ordinary sessions and V2 execution have no policy.
export const Current = Context.Reference<Policy | undefined>("@vector/SessionAdmission", {
  defaultValue: () => undefined,
})

export * as SessionAdmission from "./admission"
