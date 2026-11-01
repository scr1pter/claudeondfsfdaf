export * as CodiumUsage from "./codium-usage"

import { Billing } from "@vectordevai/schema/billing"

/** Own usage keeps its normal wording; Codium contributes a label, never a quantity. */
export function withCodium(ownText: string | undefined, codiumSteps = 0) {
  if (!(codiumSteps > 0)) return ownText ?? ""
  return ownText ? `${ownText} + ${Billing.LABEL}` : Billing.LABEL
}

/** Session totals include Codium in unpriced steps; run-guard unknown counts do not. */
export function ownUnpricedSteps(unpricedSteps = 0, codiumSteps = 0) {
  return Math.max(0, unpricedSteps - codiumSteps)
}
