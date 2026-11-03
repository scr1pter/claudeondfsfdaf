import { ENTITLEMENTS, publicEntitlements, type PerkId } from "../../packages/schema/src/codium-entitlements.js"
import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"
import { listedPerks, type ListedPerksOptions } from "./codium-perks.js"
import { readSwitch } from "./codium-switches.js"
import {
  planView,
  servedPlanModels,
  verifiedGatewayModel,
  type ModelPlanCatalogOptions,
} from "./model-plan-catalog-policy.js"
import { CODIUM_TASK_RANGES, publicModelPlans } from "./model-plan-config.js"

export type PublicCodiumOptions = ModelPlanCatalogOptions & {
  perks?: ListedPerksOptions
  /** A prerender has no live listing or offers. The island must read the runtime configuration. */
  runtime?: boolean
  now?: number
}

/** Names, accepted model variants and public caps only; private routing, rates and allowance amounts stay server-side. */
export async function publicCodiumTiers(fetcher: typeof fetch = fetch, options: PublicCodiumOptions = {}) {
  const now = options.now ?? Date.now()
  const candidateListed = await listedPerks(fetcher, {
    ...options.perks,
    runtime: options.runtime ?? options.perks?.runtime,
  })
  const runtime =
    options.runtime === false
      ? undefined
      : await Promise.all([
          servedPlanModels(options, fetcher),
          readSwitch("codium", fetcher),
          readSwitch("sales", fetcher),
        ]).catch(() => undefined)
  const listed = runtime ? candidateListed : new Set<PerkId>()
  const models = (runtime?.[0] ?? []).flatMap((model) => {
    const views = CodiumPlan.PLANS.flatMap((plan) => {
      const view = planView(model, plan.id, options.qualify ?? verifiedGatewayModel, now)
      return view.access && view.served ? [{ plan: plan.id, context: view.effective.contextLength }] : []
    })
    if (!views.length) return []
    return [
      {
        id: model.id,
        name: model.name,
        minPlan: views[0]!.plan,
        contextLength: Math.min(...views.map((view) => view.context)),
        plans: views.map((view) => view.plan),
        contextByPlan: Object.fromEntries(views.map((view) => [view.plan, view.context])),
        ...(model.category === undefined ? {} : { category: model.category }),
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(model.previewUntil !== undefined && model.previewUntil > now ? { previewUntil: model.previewUntil } : {}),
      },
    ]
  })
  const base = publicModelPlans()
  const enabled = base.enabled && runtime?.[1] === "on" && runtime?.[2] === "on" && models.length > 0
  return {
    ...base,
    enabled,
    listed: [...listed],
    models,
    plans: base.plans.map((plan) => {
      const id = plan.id as CodiumPlan.PlanId
      const multiple = ENTITLEMENTS[id].usageMultiple
      return {
        ...plan,
        available: enabled && plan.available && models.some((model) => model.plans.includes(id)),
        multiple,
        caps: publicEntitlements(id, listed),
        tasks: models.map((model) => {
          const range = CODIUM_TASK_RANGES[model.id]
          return model.plans.includes(id) && range ? ([range[0] * multiple, range[1] * multiple] as const) : null
        }),
      }
    }),
  }
}
