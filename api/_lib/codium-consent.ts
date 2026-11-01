import { ApiError } from "./http.js"
import { modelPlanStripe } from "./model-plan-stripe.js"

/** Checkout is the consent boundary; a return URL never counts as proof of agreement. */
export const CODIUM_TERMS_DATE = "2026-10-28"
export const CODIUM_CHECKOUT_CONSENT =
  "I agree to the [Codium terms](https://vectordev.ai/legal/terms#codium) and ask Vector to start my plan now. If I withdraw within 14 days I pay for what I used."

export function checkoutConsentFields(plan: { price: number; id: string }) {
  return {
    "consent_collection[terms_of_service]": "required",
    "custom_text[terms_of_service_acceptance][message]": `${CODIUM_CHECKOUT_CONSENT} Renews monthly at $${plan.price} until I cancel in my account.${plan.id === "vector-100" || plan.id === "vector-200" ? " Vector Velocity is coming and is not part of this purchase." : ""}`,
    "metadata[vector_terms_date]": CODIUM_TERMS_DATE,
    "subscription_data[metadata][vector_terms_date]": CODIUM_TERMS_DATE,
    ...(process.env.CODIUM_STRIPE_AUTOMATIC_TAX === "true" ? { "automatic_tax[enabled]": "true" } : {}),
  }
}

/** Stripe provides the recipient; idempotency belongs to the purchase, never a webhook delivery. */
export async function sendCodiumConfirmation(
  customer: string,
  session: string,
  plan: { name: string; price: number },
  fetcher: typeof fetch,
) {
  const key = process.env.RESEND_API_KEY?.trim()
  const from = process.env.VECTOR_PURCHASE_EMAIL_FROM?.trim()
  if (!key || !from) return false
  const record = await modelPlanStripe(`customers/${encodeURIComponent(customer)}`, {}, fetcher)
  if (typeof record.email !== "string" || !record.email.includes("@"))
    throw new ApiError(503, "MODEL_PLAN_CONFIRMATION", "Your purchase confirmation could not be sent.")
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": `codium-confirmation-${session}`,
    },
    body: JSON.stringify({
      from,
      to: [record.email],
      subject: `Your Vector Codium ${plan.name} plan`,
      text: `Your Vector Codium ${plan.name} plan has started. You agreed to the Codium terms and asked Vector to start now. If you withdraw within 14 days you pay for what you used. Your plan renews monthly at $${plan.price} until you cancel in your account. Change or cancel your plan at https://vectordev.ai/account. Terms: https://vectordev.ai/legal/terms#codium.`,
    }),
  })
  if (!response.ok) throw new ApiError(503, "MODEL_PLAN_CONFIRMATION", "Your purchase confirmation could not be sent.")
  return true
}
