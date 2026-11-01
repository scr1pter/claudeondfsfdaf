import { Billing } from "@vectordevai/schema/billing"
import type { StepFinishPart } from "@vectordevai/sdk/v2"

/** JSON is a public usage report; the original part still carries context tokens inside the engine. */
export function stepForOutput(part: StepFinishPart, billing?: "codium" | "own") {
  const codium = Boolean(Billing.of(part) || billing === "codium")
  if (!codium && billing === "own") return part
  const result: Partial<StepFinishPart> = {
    ...part,
    ...(codium ? { billing: "codium" as const, cost: 0, unpriced: true } : {}),
  }
  delete result.tokens
  return result
}
