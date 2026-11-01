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
  if (!codium) {
    if (!task.usage || task.usage.tokensOwnOnly === true) return
    const cost = task.usage.cost
      ? `$${task.usage.cost.toFixed(4)}${task.costKind === "unknown" || task.usage.unpricedSteps ? " + unpriced" : ""}`
      : task.costKind === "plan"
        ? "covered by plan"
        : task.costKind === "free"
          ? "free model"
          : "cost unknown"
    return ["tokens unavailable", cost]
  }
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
  const legacy = task.usage.tokensOwnOnly !== true
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

type BillingMessage = Parameters<typeof Billing.of>[0] & { role?: string }
export type Aggregate = Parameters<typeof Billing.of>[0] & {
  codiumSteps?: number
  subagentCodiumSteps?: number
  tokensOwnOnly?: boolean
  subagentTokensOwnOnly?: boolean
}

/** Evidence of Codium activity never certifies the token aggregates beside it. */
export function hasCodium(
  source: Aggregate | undefined,
  messages: readonly BillingMessage[] = [],
  children: readonly Aggregate[] = [],
): boolean {
  return Boolean(
    (source?.codiumSteps ?? 0) > 0 ||
      (source?.subagentCodiumSteps ?? 0) > 0 ||
      (source && Billing.of(source)) ||
      messages.some((message) => message.role === "assistant" && Billing.of(message)) ||
      children.some((child) => hasCodium(child)),
  )
}
