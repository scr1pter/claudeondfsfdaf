import { CodiumCopy } from "@vectordevai/schema/codium-copy"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { readModelPlanConfig, type ModelPlanConfig } from "./model-plans"

export type CodiumPricingView = ReturnType<typeof codiumPricing>
export type CodiumOffer = CodiumPricingView["monthly"][number]

/** A public presentation only: canonical purchase prices and caps, qualified models, and server-listed perks. */
export function codiumPricing(config: ModelPlanConfig) {
  const models = config.models ?? []
  const listed = config.listed ?? []
  return {
    enabled: config.enabled,
    models,
    listed,
    monthly: CodiumPlan.PLANS.map((plan) => {
      const configured = config.plans.find((entry) => entry.id === plan.id)
      const view = CodiumCopy.tierView(plan.id, new Set(listed), models)
      return {
        ...plan,
        ...view,
        available: config.enabled && configured?.available === true && view.models.length > 0,
        tasks: models.map((model, index) =>
          CodiumCopy.modelAvailable(model, plan.id) ? (configured?.tasks?.[index] ?? null) : null,
        ),
      }
    }),
  }
}

/** A stale build or failed config refresh cannot keep advertising a service that may have been switched off. */
export function unavailablePricing(pricing: CodiumPricingView) {
  return codiumPricing({
    enabled: false,
    currency: "usd",
    interval: "month",
    listed: [],
    models: [],
    plans: pricing.monthly.map((plan) => ({ ...plan, available: false })),
  })
}

export async function refreshCodiumPricing(
  pricing: CodiumPricingView,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
) {
  return fetcher("/api/model-plans/config", { headers: { accept: "application/json" }, cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Plan configuration is unavailable")
      return codiumPricing(readModelPlanConfig(await response.json()))
    })
    .catch(() => unavailablePricing(pricing))
}
