import { ENTITLEMENTS } from "../../schema/src/codium-entitlements"
import { CodiumPlan } from "../../schema/src/codium-plan"
import { modelPlans } from "../../../api/_lib/model-plan-config"

type MonthlyPlan = Pick<ReturnType<typeof modelPlans>[number], "id" | "name" | "price" | "credits">

/** Private planning only. These assumptions never affect billing, provider limits or a customer's balance. */
export function codiumEconomics(
  plans: readonly MonthlyPlan[] = modelPlans(),
  environment: Record<string, string | undefined> = process.env,
) {
  const base = plans.find((plan) => plan.id === "vector-10")?.credits ?? 0
  if (
    plans.length !== CodiumPlan.PLANS.length ||
    CodiumPlan.PLANS.some(
      (expected) => !plans.some((plan) => plan.id === expected.id && plan.price === expected.price),
    ) ||
    plans.some(
      (plan) =>
        !Number.isFinite(plan.credits) ||
        plan.credits <= 0 ||
        plan.credits > plan.price ||
        Math.round(plan.credits * 100) / 100 !== plan.credits ||
        Math.abs(plan.credits / base - ENTITLEMENTS[plan.id].usageMultiple) > 0.05,
    )
  )
    throw new Error("Configure all four MODEL_PLAN_*_CREDITS_USD allowances with the current monthly usage multiples.")

  const assumptions = {
    provider: Number(
      environment.CODIUM_PROVIDER_FEE_PERCENT?.trim() || environment.CODIUM_OPENROUTER_FEE_PERCENT?.trim() || "5.5",
    ),
    payment: Number(environment.CODIUM_PAYMENT_FEE_PERCENT?.trim() || "2.9"),
    fixed: Number(environment.CODIUM_PAYMENT_FIXED_USD?.trim() || "0.3"),
    recurring: Number(environment.CODIUM_SUBSCRIPTION_FEE_PERCENT?.trim() || "0.7"),
  }
  if (Object.values(assumptions).some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("Fee assumptions must be finite, nonnegative numbers.")

  const rows = plans.map((plan) => {
    const providerFee = (plan.credits * assumptions.provider) / 100
    const paymentFees = (plan.price * (assumptions.payment + assumptions.recurring)) / 100 + assumptions.fixed
    const beforeOtherExpenses = plan.price - plan.credits - providerFee - paymentFees
    if ([providerFee, paymentFees, beforeOtherExpenses].some((value) => !Number.isFinite(value)))
      throw new Error("Fee assumptions produce an unrepresentable estimate.")
    return {
      plan: plan.name,
      billing: "Monthly",
      price: plan.price,
      modelCredits: plan.credits,
      providerFee: providerFee.toFixed(2),
      paymentFees: paymentFees.toFixed(2),
      beforeOtherExpenses: beforeOtherExpenses.toFixed(2),
    }
  })
  return { assumptions, rows }
}

if (import.meta.main) {
  const result = codiumEconomics()
  console.log("Private Codium planning output. Includes private allowances; do not publish.")
  console.log(
    "Monthly contribution at full credit consumption; excludes hosting, support, tax, fraud, refunds and other expenses.",
  )
  console.log("Fee assumptions are unverified estimates, not provider contracts. Confirm your actual account fees.")
  console.log(
    `Assumptions: provider ${result.assumptions.provider}%, payment ${result.assumptions.payment}% + $${result.assumptions.fixed}, subscriptions ${result.assumptions.recurring}%.`,
  )
  console.table(result.rows)
}
