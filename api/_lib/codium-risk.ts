import { isPlanId } from "../../packages/schema/src/codium-plan.js"
import { ApiError } from "./http.js"
import { modelPlans } from "./model-plan-config.js"
import { listStripe, modelPlanStripe, stripeRecord } from "./model-plan-stripe.js"

/** Invalid risk settings fail closed; account configuration reports names rather than values. */
export function threeDSMinimumUsd() {
  const value = Number(process.env.CODIUM_3DS_MIN_USD?.trim() || "100")
  if (!Number.isFinite(value) || value <= 0 || value > 10_000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6)
    throw new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
  return value
}

export function fraudRefundEnabled() {
  const value = process.env.CODIUM_EFW_REFUND?.trim()
  if (value && value !== "true" && value !== "false")
    throw new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
  return value !== "false"
}

export function stripeObjectId(value: unknown) {
  return typeof value === "string" ? value : stripeRecord(value) && typeof value.id === "string" ? value.id : undefined
}

/** Only an earlier paid, unreversed Codium invoice at least this large exempts a high-value checkout. */
export async function checkoutRiskFields(
  account: string,
  customer: string,
  price: number,
  fetcher: typeof fetch,
): Promise<Record<string, string>> {
  if (price < threeDSMinimumUsd()) return {}
  const invoices = await listStripe(
    "invoices",
    [
      ["customer", customer],
      ["status", "paid"],
      ["expand[]", "data.charge"],
      ["expand[]", "data.subscription"],
    ],
    {},
    fetcher,
  )
  if (!invoices.complete)
    throw new ApiError(503, "MODEL_PLAN_RISK_UNAVAILABLE", "Your payment history could not be verified.")
  const subscriptions = new Map<string, Record<string, unknown>>()
  for (const invoice of invoices.data) {
    if (
      invoice.customer !== customer ||
      invoice.paid !== true ||
      invoice.status !== "paid" ||
      !Number.isSafeInteger(invoice.amount_paid) ||
      Number(invoice.amount_paid) < price * 100
    )
      continue
    const charge = stripeRecord(invoice.charge)
      ? invoice.charge
      : typeof invoice.charge === "string"
        ? await modelPlanStripe(`charges/${encodeURIComponent(invoice.charge)}`, {}, fetcher)
        : undefined
    if (
      !charge ||
      charge.customer !== customer ||
      charge.paid !== true ||
      charge.refunded !== false ||
      charge.disputed !== false ||
      !Number.isSafeInteger(charge.amount) ||
      Number(charge.amount) <= 0 ||
      !Number.isSafeInteger(charge.amount_refunded) ||
      Number(charge.amount_refunded) < 0 ||
      Number(charge.amount_refunded) >= Number(charge.amount)
    )
      continue
    const subscriptionID = stripeObjectId(invoice.subscription)
    if (!subscriptionID) continue
    const subscription = stripeRecord(invoice.subscription)
      ? invoice.subscription
      : (subscriptions.get(subscriptionID) ??
        (await modelPlanStripe(`subscriptions/${encodeURIComponent(subscriptionID)}`, {}, fetcher)))
    subscriptions.set(subscriptionID, subscription)
    const metadata = stripeRecord(subscription.metadata) ? subscription.metadata : undefined
    if (subscription.customer !== customer || metadata?.vector_account_id !== account) continue
    const items =
      stripeRecord(subscription.items) && Array.isArray(subscription.items.data) ? subscription.items.data : []
    const item = items.length === 1 && stripeRecord(items[0]) ? items[0] : undefined
    const currentPrice = item && stripeRecord(item.price) ? item.price : undefined
    if (!modelPlans().some((plan) => plan.priceID && plan.priceID === currentPrice?.id)) continue
    return {}
  }
  return { "payment_method_options[card][request_three_d_secure]": "any" }
}

export function authenticatedCharge(charge: Record<string, unknown> | undefined) {
  const details = charge && stripeRecord(charge.payment_method_details) ? charge.payment_method_details : undefined
  const card = details && stripeRecord(details.card) ? details.card : undefined
  const secure = card && stripeRecord(card.three_d_secure) ? card.three_d_secure : undefined
  return secure?.result === "authenticated"
}

function cardFingerprint(charge: Record<string, unknown>) {
  const details = stripeRecord(charge.payment_method_details) ? charge.payment_method_details : undefined
  const card = details && stripeRecord(details.card) ? details.card : undefined
  return card && typeof card.fingerprint === "string" && card.fingerprint ? card.fingerprint : undefined
}

/** A customer may pay for other products too; only Codium invoice/subscription provenance authorizes risk writes. */
export async function codiumChargeOwned(
  account: string,
  customer: string,
  chargeID: string,
  fetcher: typeof fetch,
  knownCharge?: Record<string, unknown>,
) {
  const charge = knownCharge ?? (await modelPlanStripe(`charges/${encodeURIComponent(chargeID)}`, {}, fetcher))
  if (charge.customer !== customer) return false
  const invoiceID = stripeObjectId(charge.invoice)
  if (!invoiceID) return false
  const invoice = await modelPlanStripe(`invoices/${encodeURIComponent(invoiceID)}`, {}, fetcher)
  const subscriptionID = stripeObjectId(invoice.subscription)
  if (invoice.customer !== customer || !subscriptionID) return false
  const subscription = await modelPlanStripe(`subscriptions/${encodeURIComponent(subscriptionID)}`, {}, fetcher)
  return (
    subscription.customer === customer &&
    stripeRecord(subscription.metadata) &&
    subscription.metadata.vector_account_id === account &&
    isPlanId(subscription.metadata.vector_plan)
  )
}

/** Re-read the warning and its payment; an unrelated customer's warning cannot act on this account. */
export async function readFraudWarning(account: string, customer: string, warningID: string, fetcher: typeof fetch) {
  const warning = await modelPlanStripe(`radar/early_fraud_warnings/${encodeURIComponent(warningID)}`, {}, fetcher)
  const chargeID = stripeObjectId(warning.charge)
  if (!chargeID || !/^(ch|py)_[A-Za-z0-9]+$/.test(chargeID))
    throw new ApiError(503, "MODEL_PLAN_RISK_UNAVAILABLE", "A payment warning could not be verified.")
  const charge = await modelPlanStripe(`charges/${encodeURIComponent(chargeID)}`, {}, fetcher)
  if (charge.customer !== customer)
    throw new ApiError(503, "MODEL_PLAN_RISK_UNAVAILABLE", "A payment warning could not be verified.")
  if (!(await codiumChargeOwned(account, customer, chargeID, fetcher, charge))) return undefined
  return { charge: chargeID, actionable: warning.actionable === true }
}

/** Idempotently refund the warned charge and other current-period charges on that same known card. */
export async function refundFraudWarning(
  customer: string,
  source: string,
  current: readonly string[],
  fetcher: typeof fetch,
  verify: () => Promise<void>,
) {
  const original = await modelPlanStripe(`charges/${encodeURIComponent(source)}`, {}, fetcher)
  if (original.customer !== customer)
    throw new ApiError(503, "MODEL_PLAN_RISK_UNAVAILABLE", "A payment warning could not be verified.")
  const fingerprint = cardFingerprint(original)
  const charges = [original]
  if (fingerprint)
    for (const id of new Set(current)) {
      if (id === source) continue
      const charge = await modelPlanStripe(`charges/${encodeURIComponent(id)}`, {}, fetcher)
      if (charge.customer === customer && cardFingerprint(charge) === fingerprint) charges.push(charge)
    }
  for (const charge of charges) {
    const id = stripeObjectId(charge)
    if (
      !id ||
      charge.paid !== true ||
      charge.refunded === true ||
      Number(charge.amount_refunded) >= Number(charge.amount)
    )
      continue
    await verify()
    await modelPlanStripe(
      "refunds",
      {
        method: "POST",
        idempotency: `vector-efw-refund-${id}`,
        body: new URLSearchParams({ charge: id, reason: "fraudulent" }),
      },
      fetcher,
    )
  }
}

/** Optional Radar work runs after mandatory cancellation and all refunds, so its failure cannot keep billing alive. */
export async function blockFraudCard(
  customer: string,
  source: string,
  fetcher: typeof fetch,
  verify: () => Promise<void>,
) {
  const blocklist = process.env.CODIUM_RADAR_BLOCKLIST_ID?.trim()
  if (!blocklist) return
  const charge = await modelPlanStripe(`charges/${encodeURIComponent(source)}`, {}, fetcher)
  if (charge.customer !== customer)
    throw new ApiError(503, "MODEL_PLAN_RISK_UNAVAILABLE", "A payment warning could not be verified.")
  const fingerprint = cardFingerprint(charge)
  if (blocklist && fingerprint) {
    await verify()
    await modelPlanStripe(
      "radar/value_list_items",
      {
        method: "POST",
        idempotency: `vector-efw-block-${source}`,
        body: new URLSearchParams({ value_list: blocklist, value: fingerprint }),
      },
      fetcher,
    )
  }
}
