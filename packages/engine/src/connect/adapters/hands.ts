export * as ConnectHandsAdapter from "./hands"

import { Effect } from "effect"
import type { Connect } from "@vectordevai/schema/connect"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerAvailability } from "@/computer/availability"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { ConnectAdapter } from "../adapter"

// Vector Hands as a member of connected tools, listed only (CW-21). The agent reaches Hands with its own `computer`
// tool, in the user's own conversation, under Hands' own questions. This adapter has no `handle`, so the hub refuses
// every hand-off to it as unknown before anything is read or asked, whoever asks: a person, a workflow stage, a
// background or after-run review (I10, I11). Whether this build offers the tool is the registry's answer, applied in
// members.ts `registered`. In a Vector cloud workspace (CW-24) the summary names the workspace, read from the engine's
// own flag; the hub reports the place (members.ts `located`).

/** The member id, which is also the tool id. */
export const ID = Hands.ID

/** The services the adapter is built over; they join the hub's dependencies (`DEPS`). */
export type Services = ComputerAvailability.Service | RuntimeFlags.Service

/** The layer nodes of `Services`, for the hub's `deps`. */
export const DEPS = [ComputerAvailability.node, RuntimeFlags.node] as const

export const factory: ConnectAdapter.Factory<Services> = Effect.gen(function* () {
  const availability = yield* ComputerAvailability.Service
  const flags = yield* RuntimeFlags.Service
  return {
    id: ID,
    owner: "hands",
    // Hands' own availability, whose bridge probe it caches for 30 s: no model call and no new destination.
    describe: () =>
      availability.unavailable().pipe(
        Effect.map(
          (reason): Connect.Member => ({
            id: ID,
            kind: "tool",
            title: Hands.NAME,
            summary: flags.cloudWorkspace
              ? "The agent uses apps in this Vector cloud workspace, with your approval."
              : "The agent uses apps on this computer, with your approval.",
            owner: "hands",
            // In this engine; the hub reads it as Vector's servers in a cloud workspace.
            place: "local",
            reach: ID,
            ...(reason
              ? { state: "unavailable" as const, reason: ComputerAvailability.message(reason) }
              : { state: "ready" as const }),
          }),
        ),
      ),
  } satisfies ConnectAdapter.Adapter
})
