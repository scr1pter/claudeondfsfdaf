import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"
import { CODIUM_MODELS, CODIUM_TIER_MODELS } from "./codium-catalog.js"
import {
  configuredPlanModels,
  effectiveModel,
  modelAccess,
  type modelPlanReservation,
  type ModelPlanModel,
} from "./model-plan-config.js"
import type { requireModelPlanCaller } from "./model-plan-caller.js"
import { CAPTURED_RESERVATIONS, RESERVATION_CAPTURE, ROUTE_ACCEPTANCES } from "./codium-reservations.js"
import { readDisabledSet } from "./codium-switches.js"

/**
 * What a catalog read (chat, /models, status and estimate) may take from a local fake instead of production. Production
 * passes nothing: the captured active catalog, `verifiedGatewayModel` and the captured reservations.
 */
export type ModelPlanCatalogOptions = {
  models?: readonly ModelPlanModel[]
  qualify?: (model: ModelPlanModel) => boolean
  reservation?: typeof modelPlanReservation
  runVerifiers?: Parameters<typeof requireModelPlanCaller>[3]
}

/**
 * The models the gateway serves now: the catalog (Pro floors and pinned routes applied) less every model or upstream
 * the owner switched off and every route without accepted evidence. With ROUTE_ACCEPTANCES empty that is none, which is
 * exactly what chat answers (503 before any snapshot), so no surface lists a model chat would refuse.
 */
export async function servedPlanModels(options: ModelPlanCatalogOptions, fetcher: typeof fetch = fetch) {
  const catalog = options.models ?? gatewayPlanModels()
  const qualify = options.qualify ?? verifiedGatewayModel
  const disabled = await readDisabledSet("models-off", fetcher)
  return catalog.filter(
    (model) => !disabled.has(model.id) && !(model.upstream && disabled.has(model.upstream)) && qualify(model),
  )
}

/**
 * How a served model appears on `plan`: whether the plan may use it, the plan its lock names (Ultra while a preview
 * runs, as chat's 403 says), the routing variant that plan would get (a locked model at its lock plan), and whether that
 * variant is itself qualified, which chat checks again before reserving anything.
 */
export function planView(
  model: ModelPlanModel,
  plan: CodiumPlan.PlanId,
  qualify: (model: ModelPlanModel) => boolean = verifiedGatewayModel,
  now = Date.now(),
) {
  const access = modelAccess(model, plan, now)
  const preview = model.previewUntil !== undefined && now < model.previewUntil ? model.previewUntil : undefined
  const lock: CodiumPlan.PlanId = preview !== undefined ? "vector-200" : (model.minPlan ?? "vector-10")
  const effective = effectiveModel(model, access ? plan : lock)
  return { access, lock, preview, effective, served: qualify(effective) }
}

/** Apply approved access tiers to the verified active catalog without activating the staged routes or larger windows. */
export function gatewayPlanModels(): readonly ModelPlanModel[] {
  return configuredPlanModels().map((model) => {
    const policy = CODIUM_TIER_MODELS.find((candidate) => candidate.id === model.id)
    return {
      ...model,
      minPlan:
        policy && CodiumPlan.rank(policy.minPlan) > CodiumPlan.rank(model.minPlan) ? policy.minPlan : model.minPlan,
      ...(policy ? { lab: policy.lab } : {}),
      ...(CAPTURED_RESERVATIONS[model.id] ? { providerOnly: [CAPTURED_RESERVATIONS[model.id]!.tag] } : {}),
    }
  })
}

/**
 * Only the unchanged captured five-model routing policy is qualified for production today. New variants, pins,
 * effort values or larger windows need provider evidence before this boundary can authorize them. Local HTTP fakes
 * inject their own explicit qualification; no environment flag can qualify a route.
 */
export function capturedGatewayModel(model: ModelPlanModel) {
  const reviewed: ModelPlanModel | undefined = CODIUM_MODELS.find((candidate) => candidate.id === model.id)
  const bounds = CAPTURED_RESERVATIONS[model.id]
  if (
    !reviewed ||
    !bounds ||
    model.upstream !== undefined ||
    model.providerOnly?.length !== 1 ||
    model.providerOnly[0] !== bounds.tag ||
    model.tierContext !== undefined ||
    !Number.isSafeInteger(model.contextLength) ||
    !Number.isSafeInteger(model.maxOutputTokens) ||
    model.contextLength < model.maxOutputTokens ||
    model.maxOutputTokens < 1 ||
    model.contextLength > reviewed.contextLength ||
    model.maxOutputTokens > reviewed.maxOutputTokens
  )
    return false
  return (
    [
      "inputPrice",
      "outputPrice",
      "quantizations",
      "reasoningEffort",
      "explicitCache",
      "cacheStyle",
      "autoToolChoice",
      "outputTokenParameter",
      "promptTokenLimit",
      "options",
    ] as const
  ).every((field) => JSON.stringify(model[field]) === JSON.stringify(reviewed[field]))
}

export function verifiedGatewayModel(model: ModelPlanModel) {
  if (!capturedGatewayModel(model)) return false
  return ROUTE_ACCEPTANCES.some(
    (accepted) =>
      accepted.model === model.id &&
      accepted.tag === model.providerOnly?.[0] &&
      accepted.captureSha256 === RESERVATION_CAPTURE.sha256 &&
      accepted.source.trim() &&
      Number.isSafeInteger(accepted.acceptedAt) &&
      accepted.acceptedAt > 0 &&
      accepted.acceptedAt <= Date.now() &&
      accepted.nativeWindowEnforced &&
      accepted.outputIncludesReasoning &&
      accepted.exactTagWithZdr &&
      accepted.capturedRatesBoundCharges,
  )
}
