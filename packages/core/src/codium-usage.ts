export * as CodiumUsage from "./codium-usage"

import { Billing } from "@vectordevai/schema/billing"
import type { Task } from "@vectordevai/schema/task"

/** Own usage keeps its normal wording; Codium contributes a label, never a quantity. */
export function withCodium(ownText: string | undefined, codiumSteps = 0) {
  if (!(codiumSteps > 0)) return ownText ?? ""
  return ownText ? `${ownText} + ${Billing.LABEL}` : Billing.LABEL
}

/** Session totals include Codium in unpriced steps; run-guard unknown counts do not. */
export function ownUnpricedSteps(unpricedSteps = 0, codiumSteps = 0) {
  return Math.max(0, unpricedSteps - codiumSteps)
}

/** Shared CLI/TUI task figures. Undefined leaves an ordinary task's existing presentation unchanged. */
export function taskText(task: Pick<Task.Info, "usage" | "costKind" | "measuredCost" | "billing">) {
  const codium = task.usage?.codiumSteps || (task.billing === "codium" || task.costKind === "codium" ? 1 : 0)
  if (!codium) return
  if (!task.usage) {
    const own = task.measuredCost
      ? `$${task.measuredCost.toFixed(4)} reported${task.costKind === "unknown" ? " + unpriced" : ""}`
      : task.costKind === "unknown"
        ? "cost unknown"
        : task.costKind === "plan"
          ? "covered by plan"
          : task.costKind === "free"
            ? "free model"
            : undefined
    return [withCodium(own, codium)]
  }
  // An old task observation cannot partition mixed tokens or unpriced steps.
  const legacy = task.usage.codiumSteps === undefined
  const unknown = task.costKind === "unknown" || (!legacy && ownUnpricedSteps(task.usage.unpricedSteps, codium) > 0)
  const ownCost = task.usage.cost
    ? `$${task.usage.cost.toFixed(4)}${unknown ? " + unpriced" : ""}`
    : unknown
      ? "cost unknown"
      : task.costKind === "plan"
        ? "covered by plan"
        : task.costKind === "free"
          ? "free model"
          : undefined
  const tokens = !legacy && task.usage.total ? `${task.usage.total.toLocaleString("en-US")} tokens` : undefined
  return [withCodium(tokens, codium), ...(ownCost ? [withCodium(ownCost, codium)] : [])]
}
