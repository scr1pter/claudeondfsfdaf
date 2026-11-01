import { MODEL_PLAN_PRICES, modelPlanOrigin, modelPlans } from "../../../api/_lib/model-plan-config"
import { MODEL_PLAN_STRIPE_VERSION, MODEL_PLAN_WEBHOOK_EVENTS } from "../../../api/_lib/model-plan-stripe"
import {
  archiveModelPlanTopups,
  modelPlanMonthlyPrices,
  modelPlanPortalConfiguration,
  modelPlanWebhook,
  requireModelPlanSetupKey,
} from "./model-plan-setup"

/** Dry-run is zero-network; explicit apply is testable through the same owner setup boundaries as the CLI. */
export async function setupModelPlans(
  options: { apply?: boolean; fetcher?: typeof fetch; log?: (line: string) => void } = {},
) {
  const log = options.log ?? console.log
  const plans = modelPlans()
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
  const webhook = `${modelPlanOrigin()}/api/model-plans/webhook${bypass ? `?${new URLSearchParams({ "x-vercel-protection-bypass": bypass })}` : ""}`
  if (!options.apply) {
    log(
      `Vector Codium: four monthly subscriptions at ${MODEL_PLAN_PRICES.map((price) => `$${price}`).join(", ")}. There are no top-ups.`,
    )
    for (const plan of plans)
      log(`${plan.name}: $${plan.price}/month; lookup vector-models-${plan.price}-monthly-v1; tax_behavior=exclusive.`)
    log("Four owned monthly products use statement descriptor VECTORDEV CODIUM and Codium plan metadata.")
    log("Archives only verified legacy Codium top-up prices; creates no top-up products or prices.")
    log(
      "One no-change portal allows payment methods, invoices and cancellation at period end. Old marked change portals are deactivated.",
    )
    log(
      `Webhook ${modelPlanOrigin()}/api/model-plans/webhook${bypass ? " (preview protection bypass configured)" : ""}: API ${MODEL_PLAN_STRIPE_VERSION}, exactly ${MODEL_PLAN_WEBHOOK_EVENTS.length} events: ${MODEL_PLAN_WEBHOOK_EVENTS.join(", ")}.`,
    )
    log(
      "No changes made. Use the owner's local STRIPE_SECRET_KEY=sk_test_… setup key with --apply; do not use the deployed rk_* runtime key.",
    )
    return { applied: false as const }
  }
  requireModelPlanSetupKey()
  const fetcher = options.fetcher ?? fetch
  const archived = await archiveModelPlanTopups(fetcher)
  for (const price of archived) log(`Archived legacy Codium top-up price ${price}.`)
  const monthly = await modelPlanMonthlyPrices(fetcher)
  for (const plan of monthly) log(`STRIPE_MODEL_PLAN_${plan.amount}_PRICE_ID=${plan.price}`)
  const portal = await modelPlanPortalConfiguration(fetcher)
  log(`STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID=${portal.id}`)
  for (const id of portal.retired)
    log(`Deactivated legacy Codium plan-change portal ${id}. Remove its obsolete environment value.`)
  const endpoint = await modelPlanWebhook(webhook, fetcher)
  if (endpoint.created) log(`STRIPE_MODEL_PLAN_WEBHOOK_SECRET=${endpoint.secret}`)
  else
    log(
      `Webhook ${endpoint.id} is enabled with exactly the supported events. Keep its existing signing secret; Stripe's dashboard holds it.`,
    )
  log(
    "Setup verified. Keep MODEL_PLANS_ENABLED=false until allowances, catalog, funding, legal and protected provider acceptance checks are complete.",
  )
  return { applied: true as const, monthly, archived, portal, endpoint }
}

if (import.meta.main)
  await setupModelPlans({ apply: process.argv.includes("--apply") }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Codium setup failed.")
    process.exitCode = 1
  })
