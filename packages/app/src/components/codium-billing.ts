import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { CodiumPlan } from "@vectordevai/schema/codium-plan"
import type { VectorBillingRequest, VectorBillingResult } from "@/vector-account"

export type BillingNotice = { kind: "done" | "info" | "error"; text: string }

const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

/** What to tell the person once a billing request is done; nothing when they only looked and closed the window. */
export function billingNotice(request: VectorBillingRequest, result: VectorBillingResult): BillingNotice | undefined {
  if (result.outcome === "failed") return { kind: "error", text: result.message }
  if (result.outcome === "website") return { kind: "info", text: "This continues on vectordev.ai in your browser." }
  if (result.outcome === "cancelled") return { kind: "info", text: "Checkout was cancelled. Nothing was charged." }
  if (result.outcome === "closed") return undefined
  if (result.outcome === "busy")
    return { kind: "info", text: "A Stripe window is already open. Finish there or close it, then try again." }
  if (result.outcome === "scheduled")
    return {
      kind: "done",
      text: `Your plan switches to ${CodiumPlan.name(result.plan) ?? result.plan} on ${ModelPlanStatus.formatDate(result.at)}. Until then it stays as it is.`,
    }
  if (result.outcome === "kept") return { kind: "done", text: "You are keeping your plan. Nothing changes at renewal." }
  if (request.kind === "checkout")
    return { kind: "done", text: "You are subscribed. Your plan shows here in a moment." }
  if (request.kind === "change")
    return { kind: "done", text: "Your plan is upgraded. It shows here in a moment, with what was left of this month." }
  if (request.kind === "portal" && request.flow === "cancel")
    return { kind: "done", text: "Your plan is cancelled. It keeps working until the end of this billing period." }
  if (request.kind === "portal" && request.flow === "payment_method_update")
    return { kind: "done", text: "Your card is updated. Your plan picks up again once the payment goes through." }
  return undefined
}

/**
 * What to say while the billing window is open. Checkout, an upgrade and the portal's cancel and card steps send the
 * person back when they finish, which closes the window; the portal's home has no end, so the person closes it. A
 * smaller plan and Keep my plan open no window: vectordev.ai saves them. `plan` is the account's plan id, which tells
 * an upgrade (a higher rank, paid in Stripe's checkout) from a smaller plan.
 */
export function billingProgress(request: VectorBillingRequest, plan?: string) {
  if (request.kind === "portal" && !request.flow) return "Manage billing in the Stripe window, then close it."
  if (
    request.kind === "keep" ||
    (request.kind === "change" && CodiumPlan.rank(request.plan) <= CodiumPlan.rank(plan ?? ""))
  )
    return "Saving your plan change…"
  return "Finish in the Stripe window. It closes by itself when you are done."
}

/** The account's plan as the plan picker reads it (ModelPlanStatus.Status["plan"]). */
export type PickerPlan = {
  id: string
  cancelAtPeriodEnd?: boolean
  state?: string
  scheduled?: { id: string; name: string; at: number }
}

/**
 * Why the plans list offers nothing yet: each offer's button follows the account's plan, so none shows until a read
 * has said what it is. Before that answer, or when the read failed, a subscriber would be offered Subscribe, which
 * vectordev.ai refuses, instead of Upgrade or Switch at renewal. Nothing once a signed-in read has answered.
 */
export function planUnknown(status: ModelPlanStatus.Status | undefined): BillingNotice | undefined {
  if (!status) return { kind: "info", text: "Reading your plan…" }
  if (status.error) return { kind: "error", text: status.error }
  if (!status.signedIn) return { kind: "info", text: "Sign in to Vector to choose a plan." }
}

/**
 * What an offer's button does, and the line under it. Nothing can be bought while Codium is not on sale, so every
 * button then reads "Coming soon". Without a plan, each one subscribes. A subscriber upgrades now (a new month starts
 * today and keeps what is left of this one) or switches to a smaller plan at renewal, both through /change. An ending or
 * paused plan, and every plan but the one already scheduled while a smaller plan is scheduled, offer no change: the
 * server refuses them, and Keep my plan comes first (§4.4).
 */
export function offerAction(
  offer: ModelPlanStatus.Offer,
  plan?: PickerPlan,
): { label: string; request?: VectorBillingRequest; current?: true; detail?: string } | undefined {
  if (plan?.id === offer.id) return { label: "Current plan", current: true }
  if (plan?.scheduled?.id === offer.id)
    return { label: `Starts ${ModelPlanStatus.formatDate(plan.scheduled.at)}`, current: true }
  if (!offer.available) return { label: "Coming soon" }
  if (!plan) return { label: "Subscribe", request: { kind: "checkout", plan: offer.id } }
  if (plan.cancelAtPeriodEnd || (plan.state !== undefined && plan.state !== "active") || plan.scheduled) return
  if (CodiumPlan.rank(offer.id) > CodiumPlan.rank(plan.id))
    return {
      label: "Upgrade",
      request: { kind: "change", plan: offer.id },
      detail: `Upgrade to ${offer.name}: ${price.format(offer.price)} today, then monthly from today. Keeps what's left of this month.`,
    }
  return {
    label: "Switch at renewal",
    request: { kind: "change", plan: offer.id },
    detail: `${offer.name} starts on your renewal date.`,
  }
}

/** "$50 a month": the public monthly price, never what it buys. */
export function offerPrice(offer: ModelPlanStatus.Offer) {
  return `${price.format(offer.price)} a month`
}
