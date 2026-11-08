export * as CliOwnerGate from "./owner-gate"

import { Effect } from "effect"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { fail, type CliError } from "./effect-cmd"

// Commands only the owner may run (section 2.1): what changes memory, learning settings or trust. An agent that could
// run them from its shell could approve its own drafts, so they refuse under the agent marker every child of a process
// that runs agents carries. Vector's own terminal carries it too, as it does for `vector local off`, so the owner runs
// them from Settings or a terminal outside Vector. Read-only commands stay open to the agent.

/** Fails when an agent, a program it ran or Vector's own terminal started this Vector. Call it first in the handler. */
export function refuse(what: string): Effect.Effect<void, CliError> {
  if (process.env[ChildEnvironment.AGENT_MARKER] === undefined) return Effect.void
  return fail(`Vector's agents cannot ${what}. Use Settings in the app, or run it in a terminal outside Vector.`)
}
