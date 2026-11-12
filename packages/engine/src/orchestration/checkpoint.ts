export * as WorkflowCheckpoint from "./checkpoint"

import { Effect, Option, Schema } from "effect"
import type { WorkflowCheckpointStore } from "@vectordevai/core/workflow-checkpoint-store"
import type { SubagentRecord, SubagentUsage } from "@/agent/subagent-kind"
import type { SessionID } from "@/session/schema"
import { WorkflowState } from "./state"

/**
 * The run's checkpoint value (G.6): its own row in the checkpoint table, or the copy a build before that table kept in
 * the run's lifecycle metadata. Undefined before the first save.
 */
export const load = Effect.fn("WorkflowCheckpoint.load")(function* (
  store: Pick<WorkflowCheckpointStore.Interface, "read">,
  runID: SessionID,
  record: Pick<SubagentRecord, "attempt" | "workflow"> | undefined,
) {
  const row = yield* store.read(runID)
  if (!row) return record?.workflow?.role === "run" ? record.workflow.progress.runtime : undefined
  if (record?.attempt !== undefined && row.attempt > record.attempt)
    return yield* new WorkflowState.StateError({
      code: "integrity",
      path: "",
      message: "The workflow checkpoint belongs to a newer attempt than its run.",
    })
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(row.data)
  if (Option.isNone(parsed))
    return yield* new WorkflowState.StateError({
      code: "shape",
      path: "",
      message: "The saved workflow checkpoint is not valid JSON.",
    })
  return parsed.value
})

const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
/**
 * The step and tool totals of the latest checkpoint, kept in the run's protected lifecycle record. Lifecycle
 * observation (task lists, settlement) reads this summary instead of loading and decoding the whole checkpoint row.
 */
export const Accounting = Schema.Struct({ steps: count, toolUses: count })
export type Accounting = typeof Accounting.Type

export function accounting(state: {
  readonly usage: { readonly steps: number }
  readonly sessions: Readonly<Record<string, Pick<SubagentUsage, "steps" | "toolUses">>>
}): Accounting {
  const children = Object.values(state.sessions)
  return {
    steps: Math.max(
      state.usage.steps,
      children.reduce((sum, child) => sum + child.steps, 0),
    ),
    toolUses: children.reduce((sum, child) => sum + child.toolUses, 0),
  }
}
