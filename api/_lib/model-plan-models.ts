import { ENTITLEMENTS, type PlanState } from "../../packages/schema/src/codium-entitlements.js"
import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"
import { CODIUM_AUTO_ROLES, CODIUM_JUDGES, CODIUM_REVIEW_PAIRS } from "./codium-catalog.js"
import { readSnapshot } from "./codium-snapshot.js"
import { readSwitch } from "./codium-switches.js"
import { requireModelPlanCaller, requireModelPlanClient } from "./model-plan-caller.js"
import {
  planView,
  servedPlanModels,
  verifiedGatewayModel,
  type ModelPlanCatalogOptions,
} from "./model-plan-catalog-policy.js"
import { modelPlansEnabled, requireModelPlans } from "./model-plan-config.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"

export const CODIUM_AUTO_ID = "vector/codium-auto"
// A paused or frozen plan is still the account's: its catalog shows what it would serve once the notice is resolved.
const LISTING_STATES: ReadonlySet<PlanState> = new Set(["active", "renewing", "paused", "frozen"])

/**
 * `GET /api/model-plans/models` (§4.12), polled about once a minute. It reads only the store: the account's snapshot
 * (a raw read, never `readEntitlement`, so a missing or stale snapshot costs no Stripe reconcile here), the `codium`
 * switch and the `models-off` set, and never Stripe or OpenRouter. Only models the gateway serves are listed (catalog
 * minus `models-off` minus routes without accepted evidence), so no listed model is one chat would answer 503. Locks
 * and `limits` are relative to the snapshot's plan, or to Plus's without a plan. Every number is a public catalog
 * figure, a public cap or a timestamp (P1); routing policy and the price ceilings stay on the server.
 */
export async function handleModelPlanModels(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
  options: ModelPlanCatalogOptions = {},
) {
  try {
    requireMethod(request, "GET")
    if (!modelPlansEnabled()) {
      json(response, 200, { enabled: false, models: [] })
      return
    }
    // Older clients cannot interpret the new paid caller contract; catalog reads remain an empty list.
    try {
      requireModelPlanClient(request)
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "CODIUM_UPDATE_REQUIRED") throw error
      json(response, 200, { enabled: false, models: [] })
      return
    }
    requireModelPlans()
    const caller = await requireModelPlanCaller(request, fetcher, Date.now(), options.runVerifiers)
    if ((await readSwitch("codium", fetcher)) !== "on") {
      json(response, 200, { enabled: false, models: [] })
      return
    }
    const snapshot = await readSnapshot(caller.account.id, fetcher)
    const plan = snapshot?.plan && LISTING_STATES.has(snapshot.state) ? snapshot.plan : null
    const catalog = planCatalog(await servedPlanModels(options, fetcher), plan ?? "vector-10", options)
    // Old clients get only what they can use, in the shape they decode: no locks, no manual-only variants (they cannot
    // keep those out of helpers and routing) and no Auto.
    if (request.headers["x-vector-catalog"] !== "2") {
      json(response, 200, {
        enabled: true,
        models: catalog.listed
          .filter((model) => !model.locked && !model.manualOnly)
          .map((model) => ({
            id: model.id,
            name: model.name,
            contextLength: model.contextLength,
            maxOutputTokens: model.maxOutputTokens,
          })),
      })
      return
    }
    json(response, 200, {
      enabled: true,
      plan,
      limits: { inFlight: plan && snapshot ? snapshot.caps.inFlight : ENTITLEMENTS["vector-10"].inFlight },
      models: catalog.models,
      ...(catalog.judges ? { judges: catalog.judges } : {}),
      review: catalog.review,
    })
  } catch (error) {
    handleApiError(response, error)
  }
}

/**
 * The served models as `plan` sees them, in catalog order, with Codium Auto after its default model; the Second
 * opinion judges and the review pairs whose members this plan can use. Auto's roles resolve only to served, unlocked,
 * not manual-only models: a missing floor or ceiling falls back to the default, a missing default to the floor, and
 * without either Auto is not offered. A judge pair needs both models usable and a judge that is not manual-only.
 */
function planCatalog(
  served: Awaited<ReturnType<typeof servedPlanModels>>,
  plan: CodiumPlan.PlanId,
  options: ModelPlanCatalogOptions,
  now = Date.now(),
) {
  const roles = CODIUM_AUTO_ROLES[plan]
  const listed = served.flatMap((model) => {
    const view = planView(model, plan, options.qualify ?? verifiedGatewayModel, now)
    if (!view.served) return []
    const role =
      !view.access || model.manualOnly
        ? undefined
        : model.id === roles.default
          ? ("default" as const)
          : model.id === roles.floor
            ? ("floor" as const)
            : model.id === roles.ceiling
              ? ("ceiling" as const)
              : undefined
    // Undefined fields are left out of the JSON answer.
    return [
      {
        id: model.id,
        name: model.name,
        contextLength: view.effective.contextLength,
        maxOutputTokens: view.effective.maxOutputTokens,
        lab: model.lab,
        // A public price ratio (DeepSeek = 1), rounded to two decimal places.
        weight: Math.round((model.weight ?? (model.inputPrice + model.outputPrice) / 1.5) * 100) / 100,
        role,
        manualOnly: model.manualOnly || undefined,
        locked: view.access
          ? undefined
          : { plan: view.lock, name: CodiumPlan.name(view.lock) ?? view.lock, previewUntil: view.preview },
        preview: view.access && view.preview !== undefined ? { until: view.preview } : undefined,
      },
    ]
  })
  const usable = (id: string) => listed.find((model) => model.id === id && !model.locked && !model.manualOnly)
  const fallback = usable(roles.default) ?? usable(roles.floor)
  const resolved = fallback && {
    floor: usable(roles.floor) ?? fallback,
    default: fallback,
    ceiling: usable(roles.ceiling) ?? fallback,
  }
  const auto = resolved && {
    id: CODIUM_AUTO_ID,
    name: "Codium Auto",
    contextLength: Math.min(
      resolved.floor.contextLength,
      resolved.default.contextLength,
      resolved.ceiling.contextLength,
    ),
    maxOutputTokens: Math.min(
      resolved.floor.maxOutputTokens,
      resolved.default.maxOutputTokens,
      resolved.ceiling.maxOutputTokens,
    ),
    // Auto is described by its default model: its lab and its price ratio.
    lab: resolved.default.lab,
    weight: resolved.default.weight,
    auto: { floor: resolved.floor.id, default: resolved.default.id, ceiling: resolved.ceiling.id },
  }
  const after = auto ? listed.findIndex((model) => model.id === auto.auto.default) + 1 : listed.length
  const pairs = Object.entries(CODIUM_JUDGES[plan] as Record<string, string>).filter(
    ([worker, judge]) => listed.some((model) => model.id === worker && !model.locked) && usable(judge) !== undefined,
  )
  return {
    listed,
    models: auto ? [...listed.slice(0, after), auto, ...listed.slice(after)] : listed,
    ...(pairs.length ? { judges: Object.fromEntries(pairs) } : {}),
    review: Object.fromEntries(Object.entries(CODIUM_REVIEW_PAIRS[plan]).filter(([, id]) => usable(id))),
  }
}
