import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

// Settings → General's Second opinion row (WP A35). It shows only when vectordev.ai's status says the signed-in
// account's Codium plan includes Second opinion and the perk is listed (publicEntitlements carries the flag only for
// listed perks, H1). The engine decides each judge from the plan's catalog, and the gateway from the plan itself.

export const SECOND_OPINION_TITLE = "Second opinion"
export const SECOND_OPINION_DESCRIPTION =
  "When the judge checks work done on a Vector Codium model, a model from another lab does the checking, from your plan's judges. A judge model you set yourself always wins. It uses more of your month than judging on the same model. Off by default."

/** Whether Settings offers Second opinion: the plan includes it and vectordev.ai lists it. */
export function secondOpinionOffered(status: ModelPlanStatus.Status | undefined) {
  return Boolean(status?.signedIn && !status.error && status.entitlements?.secondOpinion === true)
}
