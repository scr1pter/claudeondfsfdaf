import { Billing } from "@vectordevai/schema/billing"
import type { StepFinishPart } from "@vectordevai/sdk/v2"

/** JSON is a public usage report; the original part still carries context tokens inside the engine. */
export function stepForOutput(part: StepFinishPart, billing?: "codium") {
  if (!(Billing.of(part) || billing === "codium")) return part
  const result: Partial<StepFinishPart> = { ...part, billing: "codium", cost: 0, unpriced: true }
  delete result.tokens
  return result
}
