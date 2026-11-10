import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import { readAccountApiResponse } from "./account-client"
import {
  modelPlanRedirect,
  readModelPlanStatus,
  type ModelPlan,
  type ModelPlanConfig,
  type ModelPlanStatus,
} from "./model-plans"

export type ModelPlanAction =
  | { kind: "checkout" | "change"; plan: string }
  | { kind: "keep" }
  | { kind: "portal"; flow?: "payment_method_update" | "cancel" }
export type ModelPlanActionResult =
  | { url: string }
  | { scheduled: { id: string; name: string; at: number } }
  | { kept: true }
export type ModelPlanOffer = { label: string; request?: ModelPlanAction; detail?: string; current?: true }

export function modelPlanRecovery(
  status: ModelPlanStatus | undefined | null,
): { label: string; request: ModelPlanAction } | undefined {
  if (status?.plan?.state !== "paused") return undefined
  return status.plan.action === "confirm-payment" || status.plan.reason === "action_required"
    ? { label: "Confirm payment", request: { kind: "portal" } }
    : { label: "Update payment method", request: { kind: "portal", flow: "payment_method_update" } }
}

export async function fetchModelPlanAccount(accessToken: string, fetcher: typeof fetch = fetch) {
  if (!accessToken.trim()) throw new Error("Sign in to read your Codium plan.")
  const response = await fetcher("/api/model-plans/status", {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    redirect: "error",
  })
  return readModelPlanStatus(await readAccountApiResponse(response, "Vector could not read your plan. Try again."))
}

/** Plan-aware intent only. The server remains authoritative for every billing mutation. */
export function modelPlanOffer(
  config: ModelPlanConfig,
  offer: ModelPlan,
  status: ModelPlanStatus | undefined,
): ModelPlanOffer | undefined {
  if (!status || !CodiumPlan.isPlanId(offer.id)) return undefined
  const plan = status.plan
  if (plan?.id === offer.id) return { label: "Current plan", current: true }
  if (plan?.scheduled?.id === offer.id) return { label: "Scheduled at renewal", current: true }
  if (
    plan &&
    (plan.changeBlocked ||
      plan.cancelAtPeriodEnd ||
      (plan.state !== undefined && plan.state !== "active") ||
      plan.scheduled)
  )
    return undefined
  // Scheduling a lower tier does not buy another month; the server permits it while new sales are paused.
  if (status.active && plan && CodiumPlan.isPlanId(plan.id) && CodiumPlan.rank(offer.id) < CodiumPlan.rank(plan.id))
    return {
      label: "Switch at renewal",
      detail: `${CodiumPlan.name(offer.id)} starts on your renewal date.`,
      request: { kind: "change", plan: offer.id },
    }
  if (!config.enabled || status.enabled === false || !offer.available) return { label: "Coming soon" }
  if (!status.active) return { label: `Choose ${offer.name}`, request: { kind: "checkout", plan: offer.id } }
  if (!plan || !CodiumPlan.isPlanId(plan.id)) return undefined
  if (CodiumPlan.rank(offer.id) > CodiumPlan.rank(plan.id)) {
    const price = CodiumPlan.PLANS.find((plan) => plan.id === offer.id)!.price
    return {
      label: `Upgrade to ${CodiumPlan.name(offer.id)}: $${price} today, then monthly from today. Keeps what's left of this month.`,
      request: { kind: "change", plan: offer.id },
    }
  }
  return {
    label: "Switch at renewal",
    detail: `${CodiumPlan.name(offer.id)} starts on your renewal date.`,
    request: { kind: "change", plan: offer.id },
  }
}

/** Uses a signed-in browser token, explicit endpoint/method, and a bounded public response shape. */
export async function executeModelPlanAction(
  request: ModelPlanAction,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<ModelPlanActionResult> {
  if (
    !accessToken.trim() ||
    ((request.kind === "checkout" || request.kind === "change") && !CodiumPlan.isPlanId(request.plan))
  )
    throw new Error("Sign in and choose an available Codium plan.")
  const path = request.kind === "keep" ? "change" : request.kind
  const response = await fetcher(`/api/model-plans/${path}`, {
    method: request.kind === "keep" ? "DELETE" : "POST",
    redirect: "error",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(
      request.kind === "checkout" || request.kind === "change"
        ? { plan: request.plan }
        : request.kind === "portal" && request.flow
          ? { flow: request.flow }
          : {},
    ),
  })
  const body = await readAccountApiResponse(response, "Vector could not update billing. Try again.")
  if (request.kind === "portal" || request.kind === "checkout") return { url: modelPlanRedirect(body, request.kind) }
  if (request.kind === "keep" && body.scheduled === false) return { kept: true }
  if (request.kind === "change") {
    if (body.url !== undefined) return { url: modelPlanRedirect(body, "checkout") }
    const scheduled = body.scheduled
    if (
      scheduled &&
      typeof scheduled === "object" &&
      "plan" in scheduled &&
      scheduled.plan === request.plan &&
      "at" in scheduled &&
      typeof scheduled.at === "number" &&
      Number.isSafeInteger(scheduled.at) &&
      scheduled.at > 0 &&
      Number.isFinite(new Date(scheduled.at).getTime())
    )
      return { scheduled: { id: request.plan, name: CodiumPlan.name(request.plan)!, at: scheduled.at } }
  }
  throw new Error("Vector could not confirm the plan change. Refresh your account before trying again.")
}
