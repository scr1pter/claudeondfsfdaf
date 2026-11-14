import { Effect } from "effect"
import type { ConnectAdapter } from "@/connect/adapter"

// A labelled test member, not a substitute qualification of VectorScope's Linux-only Git reader.
// The real hub must obtain consent before this inert adapter can return its explicit non-review.
export const connectConsentMember: ConnectAdapter.Adapter = {
  id: "vectorscope",
  owner: "vectorscope",
  describe: () =>
    Effect.succeed({
      id: "vectorscope",
      owner: "vectorscope",
      kind: "agent",
      title: "Synthetic consent fixture",
      summary: "Exercises owner consent without native Git or a review model.",
      place: "local",
      sendsTo: "this-computer",
      state: "ready",
      reach: "connect",
      actions: [{ id: "review", title: "Synthetic review", effects: ["read"], background: true, result: "review" }],
    }),
  handle: () =>
    Effect.succeed({
      state: "refused",
      verdict: "not-reviewed",
      summary: "The synthetic consent fixture does not execute a code review.",
      findings: [],
      sessions: [],
      notes: [],
      cost: { kind: "local" },
      sendsTo: "this-computer",
    }),
}
