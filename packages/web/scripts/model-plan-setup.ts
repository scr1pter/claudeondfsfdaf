import { randomUUID } from "node:crypto"
import { modelPlans, MODEL_PLAN_PRICES } from "../../../api/_lib/model-plan-config"
import {
  MODEL_PLAN_STRIPE_VERSION,
  MODEL_PLAN_WEBHOOK_EVENTS,
  modelPlanStripe,
  requireStripeMode,
  stripeRecord,
} from "../../../api/_lib/model-plan-stripe"

const PORTAL_MARK = "portal-v1"
const CHANGE_PORTAL_MARK = "plan-change-v1"
const MONTHLY_MARK = "monthly-v1"
const DESCRIPTOR = "VECTORDEV CODIUM"

/** Setup is a local owner operation. The deployed restricted key must never be used for it. */
export function requireModelPlanSetupKey() {
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key || !/^sk_(test|live)_\w+$/.test(key))
    throw new Error(
      "Use the owner's local STRIPE_SECRET_KEY=sk_test_… setup key; deployed rk_* runtime keys cannot run setup.",
    )
  requireStripeMode()
}
function setupStripe(path: string, input: Parameters<typeof modelPlanStripe>[1] = {}, fetcher: typeof fetch = fetch) {
  requireModelPlanSetupKey()
  return modelPlanStripe(path, input, fetcher)
}

/** Four lookup-bound monthly prices, each on its own Codium product. Validate existing identity before any repair. */
export async function modelPlanMonthlyPrices(fetcher: typeof fetch = fetch) {
  requireModelPlanSetupKey()
  const plans = modelPlans()
  const prices = await Promise.all(
    plans.map(async (plan) => {
      const lookup = `vector-models-${plan.price}-monthly-v1`
      const found = await stripeList(`prices?${new URLSearchParams({ "lookup_keys[]": lookup })}`, fetcher)
      if (found.length > 1) throw new Error(`More than one Stripe price matches ${lookup}.`)
      if (found[0]) validateMonthlyPrice(found[0], plan.price, lookup, false)
      return { plan, lookup, price: found[0] }
    }),
  )
  const bound = prices.flatMap((value) => (value.price ? [value.price.product] : []))
  if (new Set(bound).size !== bound.length) throw new Error("Each monthly price must use its own Codium product.")
  const products = prices.some((value) => !value.price) ? await stripeList("products?active=true", fetcher) : []
  const prepared = await Promise.all(
    prices.map(async (value) => {
      const matching = products.filter(
        (product) =>
          stripeRecord(product.metadata) &&
          product.metadata.vector_codium === MONTHLY_MARK &&
          product.metadata.vector_plan === value.plan.id,
      )
      if (!value.price && matching.length > 1)
        throw new Error(`More than one Codium product is marked for ${value.plan.id}; resolve it before setup.`)
      const product = value.price
        ? await setupStripe(`products/${encodeURIComponent(String(value.price.product))}`, {}, fetcher)
        : matching[0]
      if (product) validateMonthlyProduct(product, value.plan, Boolean(value.price))
      return { ...value, product }
    }),
  )
  const productIDs = prepared.flatMap((value) => (value.product ? [value.product.id] : []))
  if (new Set(productIDs).size !== productIDs.length)
    throw new Error("Each monthly plan must use a distinct Codium product.")
  const monthly: { plan: string; amount: number; product: string; price: string }[] = []
  for (const value of prepared) {
    const metadata = { vector_codium: MONTHLY_MARK, vector_plan: value.plan.id }
    const productBody = new URLSearchParams({
      name: `Vector Codium ${value.plan.name}`,
      statement_descriptor: DESCRIPTOR,
      "metadata[vector_codium]": metadata.vector_codium,
      "metadata[vector_plan]": metadata.vector_plan,
    })
    const product =
      value.product ??
      (await setupStripe(
        "products",
        { method: "POST", idempotency: `vector-codium-product-${randomUUID()}`, body: productBody },
        fetcher,
      ))
    if (typeof product.id !== "string") throw new Error("Stripe did not return the monthly Codium product.")
    if (
      value.product &&
      (product.name !== `Vector Codium ${value.plan.name}` ||
        product.statement_descriptor !== DESCRIPTOR ||
        !hasMetadata(product, metadata))
    )
      await setupStripe(
        `products/${encodeURIComponent(product.id)}`,
        { method: "POST", idempotency: `vector-codium-product-update-${randomUUID()}`, body: productBody },
        fetcher,
      )
    const confirmedProduct = await setupStripe(`products/${encodeURIComponent(product.id)}`, {}, fetcher)
    validateMonthlyProduct(confirmedProduct, value.plan, false)
    if (
      confirmedProduct.id !== product.id ||
      confirmedProduct.name !== `Vector Codium ${value.plan.name}` ||
      confirmedProduct.statement_descriptor !== DESCRIPTOR ||
      !hasMetadata(confirmedProduct, metadata)
    )
      throw new Error(`Stripe did not confirm ${value.plan.id}'s descriptor and metadata.`)
    const price =
      value.price ??
      (await setupStripe(
        "prices",
        {
          method: "POST",
          idempotency: `vector-codium-price-${randomUUID()}`,
          body: new URLSearchParams({
            currency: "usd",
            unit_amount: String(value.plan.price * 100),
            "recurring[interval]": "month",
            product: product.id,
            lookup_key: value.lookup,
            tax_behavior: "exclusive",
            "metadata[vector_codium]": metadata.vector_codium,
            "metadata[vector_plan]": metadata.vector_plan,
          }),
        },
        fetcher,
      ))
    if (typeof price.id !== "string") throw new Error("Stripe did not return the monthly Codium price.")
    if (value.price && (price.tax_behavior !== "exclusive" || !hasMetadata(price, metadata)))
      await setupStripe(
        `prices/${encodeURIComponent(price.id)}`,
        {
          method: "POST",
          idempotency: `vector-codium-price-update-${randomUUID()}`,
          body: new URLSearchParams({
            tax_behavior: "exclusive",
            "metadata[vector_codium]": metadata.vector_codium,
            "metadata[vector_plan]": metadata.vector_plan,
          }),
        },
        fetcher,
      )
    const confirmedPrice = await setupStripe(`prices/${encodeURIComponent(price.id)}`, {}, fetcher)
    validateMonthlyPrice(confirmedPrice, value.plan.price, value.lookup, true)
    if (
      confirmedPrice.id !== price.id ||
      confirmedPrice.product !== product.id ||
      !hasMetadata(confirmedPrice, metadata)
    )
      throw new Error(`Stripe did not confirm ${value.plan.id}'s product and metadata.`)
    monthly.push({ plan: value.plan.id, amount: value.plan.price, product: product.id, price: price.id })
  }
  return monthly
}
function validateMonthlyPrice(price: Record<string, unknown>, amount: number, lookup: string, exclusive: boolean) {
  if (
    typeof price.id !== "string" ||
    typeof price.product !== "string" ||
    price.lookup_key !== lookup ||
    price.currency !== "usd" ||
    price.unit_amount !== amount * 100 ||
    price.active !== true ||
    !stripeRecord(price.recurring) ||
    price.recurring.interval !== "month" ||
    price.recurring.interval_count !== 1
  )
    throw new Error(`Existing Stripe price ${lookup} has unexpected monthly billing settings.`)
  if (price.tax_behavior === "inclusive")
    throw new Error(
      `Price ${lookup} uses immutable inclusive tax. Replace it with an exclusive price and transfer its lookup key before setup.`,
    )
  if (
    (exclusive && price.tax_behavior !== "exclusive") ||
    (!exclusive &&
      price.tax_behavior !== undefined &&
      price.tax_behavior !== null &&
      price.tax_behavior !== "unspecified" &&
      price.tax_behavior !== "exclusive")
  )
    throw new Error(`Stripe price ${lookup} does not have the required exclusive tax behavior.`)
}
function validateMonthlyProduct(
  product: Record<string, unknown>,
  plan: { id: string; name: string; price: number },
  legacy: boolean,
) {
  const metadata = stripeRecord(product.metadata) ? product.metadata : {}
  const marked = metadata.vector_codium === MONTHLY_MARK && metadata.vector_plan === plan.id
  const historical =
    legacy &&
    metadata.vector_codium === undefined &&
    metadata.vector_plan === undefined &&
    [`Vector Codium ${plan.price}`, `Vector Codium ${plan.name}`].includes(String(product.name))
  if (typeof product.id !== "string" || product.active !== true || (!marked && !historical))
    throw new Error(`The product for ${plan.id} is not its owned Codium monthly product; no product was repurposed.`)
}
function hasMetadata(value: Record<string, unknown>, metadata: Record<string, string>) {
  const actual = stripeRecord(value.metadata) ? value.metadata : undefined
  return actual !== undefined && Object.entries(metadata).every(([key, expected]) => actual[key] === expected)
}

/** Retire only the exact one-time lookup keys and legacy product identities that the old Codium script created. */
export async function archiveModelPlanTopups(fetcher: typeof fetch = fetch) {
  requireModelPlanSetupKey()
  const archived: string[] = []
  for (const amount of MODEL_PLAN_PRICES) {
    const lookup = `vector-codium-topup-${amount}-v1`
    const found = await stripeList(`prices?${new URLSearchParams({ "lookup_keys[]": lookup })}`, fetcher)
    if (found.length > 1) throw new Error(`More than one legacy price matches ${lookup}; resolve it before setup.`)
    const price = found[0]
    if (!price || price.active === false) continue
    if (
      typeof price.id !== "string" ||
      typeof price.product !== "string" ||
      price.currency !== "usd" ||
      price.unit_amount !== amount * 100 ||
      price.recurring != null ||
      price.lookup_key !== lookup
    )
      throw new Error(`Legacy price ${lookup} could not be verified; it was not archived.`)
    const product = await setupStripe(`products/${encodeURIComponent(price.product)}`, {}, fetcher)
    if (
      ![`Vector Codium ${amount} top-up`, `Vector Codium $${amount} credit top-up`].includes(String(product.name)) ||
      (stripeRecord(product.metadata) && product.metadata.vector_plan !== undefined)
    )
      throw new Error(`Legacy price ${lookup}'s product could not be verified; it was not archived.`)
    await setupStripe(
      `prices/${encodeURIComponent(price.id)}`,
      {
        method: "POST",
        idempotency: `vector-codium-topup-archive-${randomUUID()}`,
        body: new URLSearchParams({ active: "false" }),
      },
      fetcher,
    )
    if ((await setupStripe(`prices/${encodeURIComponent(price.id)}`, {}, fetcher)).active !== false)
      throw new Error(`Stripe did not confirm that legacy price ${price.id} was archived.`)
    archived.push(price.id)
  }
  return archived
}

/** One no-change portal. Previously marked plan-change portals are deactivated, never recreated. */
export async function modelPlanPortalConfiguration(fetcher: typeof fetch = fetch) {
  requireModelPlanSetupKey()
  const configurations = await stripeList("billing_portal/configurations?active=true", fetcher)
  const matching = configurations.filter(
    (value) => stripeRecord(value.metadata) && value.metadata.vector_codium === PORTAL_MARK,
  )
  if (matching.length > 1)
    throw new Error("More than one active Codium no-change portal is marked; resolve it before setup.")
  const body = new URLSearchParams({
    "business_profile[headline]": "Manage your Vector Codium subscription",
    "features[customer_update][enabled]": "true",
    "features[customer_update][allowed_updates][0]": "email",
    "features[invoice_history][enabled]": "true",
    "features[payment_method_update][enabled]": "true",
    "features[subscription_cancel][enabled]": "true",
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_update][enabled]": "false",
    "metadata[vector_codium]": PORTAL_MARK,
  })
  const existing = matching[0]
  const portal =
    existing ??
    (await setupStripe(
      "billing_portal/configurations",
      { method: "POST", idempotency: `vector-codium-portal-${randomUUID()}`, body },
      fetcher,
    ))
  if (typeof portal.id !== "string") throw new Error("Stripe did not return a billing portal configuration.")
  if (existing && !portalCorrect(existing))
    await setupStripe(
      `billing_portal/configurations/${encodeURIComponent(portal.id)}`,
      { method: "POST", idempotency: `vector-codium-portal-update-${randomUUID()}`, body },
      fetcher,
    )
  if (!portalCorrect(await setupStripe(`billing_portal/configurations/${encodeURIComponent(portal.id)}`, {}, fetcher)))
    throw new Error("Stripe did not confirm the no-change portal settings.")
  const retired: string[] = []
  for (const legacy of configurations.filter(
    (value) => stripeRecord(value.metadata) && value.metadata.vector_codium === CHANGE_PORTAL_MARK,
  )) {
    if (typeof legacy.id !== "string") throw new Error("The legacy plan-change portal could not be verified.")
    await setupStripe(
      `billing_portal/configurations/${encodeURIComponent(legacy.id)}`,
      {
        method: "POST",
        idempotency: `vector-codium-portal-retire-${randomUUID()}`,
        body: new URLSearchParams({ active: "false" }),
      },
      fetcher,
    )
    if (
      (await setupStripe(`billing_portal/configurations/${encodeURIComponent(legacy.id)}`, {}, fetcher)).active !==
      false
    )
      throw new Error("Stripe did not confirm the legacy plan-change portal was deactivated.")
    retired.push(legacy.id)
  }
  return { id: portal.id, created: !existing, retired }
}
function portalCorrect(portal: Record<string, unknown>) {
  const features = stripeRecord(portal.features) ? portal.features : undefined
  const feature = (name: string) => (features && stripeRecord(features[name]) ? features[name] : undefined)
  return (
    portal.active === true &&
    stripeRecord(portal.metadata) &&
    portal.metadata.vector_codium === PORTAL_MARK &&
    feature("subscription_update")?.enabled === false &&
    feature("payment_method_update")?.enabled === true &&
    feature("invoice_history")?.enabled === true &&
    feature("subscription_cancel")?.enabled === true &&
    feature("subscription_cancel")?.mode === "at_period_end"
  )
}

/** Exactly the supported events at the pinned immutable API version, enabled and verified by fresh provider reads. */
export async function modelPlanWebhook(url: string, fetcher: typeof fetch = fetch) {
  requireModelPlanSetupKey()
  const target = new URL(url)
  const registered = (await stripeList("webhook_endpoints", fetcher)).filter((endpoint) => {
    const address = typeof endpoint.url === "string" && URL.canParse(endpoint.url) ? new URL(endpoint.url) : undefined
    return address?.origin === target.origin && address.pathname === target.pathname
  })
  if (registered.length > 1)
    throw new Error("More than one webhook uses this Codium address; resolve duplicates before setup.")
  const existing = registered[0]
  if (existing && existing.api_version !== MODEL_PLAN_STRIPE_VERSION)
    throw new Error(
      `Webhook ${String(existing.id)} uses a different immutable API version. Recreate it at ${MODEL_PLAN_STRIPE_VERSION} and save the new signing secret before setup.`,
    )
  const body = new URLSearchParams({ url, disabled: "false" })
  MODEL_PLAN_WEBHOOK_EVENTS.forEach((name, index) => body.set(`enabled_events[${index}]`, name))
  if (existing) {
    if (typeof existing.id !== "string") throw new Error("The existing Codium webhook could not be verified.")
    const updated = existing.url !== url || !webhookCorrect(existing, url)
    if (updated)
      await setupStripe(
        `webhook_endpoints/${encodeURIComponent(existing.id)}`,
        { method: "POST", idempotency: `vector-codium-webhook-update-${randomUUID()}`, body },
        fetcher,
      )
    if (!webhookCorrect(await setupStripe(`webhook_endpoints/${encodeURIComponent(existing.id)}`, {}, fetcher), url))
      throw new Error("Stripe did not confirm the exact Codium webhook settings.")
    return { id: existing.id, created: false as const, updated, missing: [] as string[] }
  }
  body.delete("disabled")
  body.set("api_version", MODEL_PLAN_STRIPE_VERSION)
  body.set("description", "Vector Codium subscriptions and ledger")
  const created = await setupStripe(
    "webhook_endpoints",
    { method: "POST", idempotency: `vector-codium-webhook-${randomUUID()}`, body },
    fetcher,
  )
  if (typeof created.id !== "string" || typeof created.secret !== "string" || !created.secret)
    throw new Error("Stripe did not return the webhook's signing secret.")
  const confirmed = (await stripeList("webhook_endpoints", fetcher)).filter((endpoint) => {
    const address = typeof endpoint.url === "string" && URL.canParse(endpoint.url) ? new URL(endpoint.url) : undefined
    return address?.origin === target.origin && address.pathname === target.pathname
  })
  if (
    confirmed.length !== 1 ||
    confirmed[0]!.id !== created.id ||
    !webhookCorrect(confirmed[0]!, url) ||
    !webhookCorrect(await setupStripe(`webhook_endpoints/${encodeURIComponent(created.id)}`, {}, fetcher), url)
  )
    throw new Error(`Stripe does not confirm the new webhook ${created.id}; run setup again.`)
  return { id: created.id, created: true as const, secret: created.secret }
}
function webhookCorrect(endpoint: Record<string, unknown>, url: string) {
  const events = endpoint.enabled_events
  return (
    endpoint.url === url &&
    endpoint.api_version === MODEL_PLAN_STRIPE_VERSION &&
    endpoint.status === "enabled" &&
    Array.isArray(events) &&
    events.length === MODEL_PLAN_WEBHOOK_EVENTS.length &&
    new Set(events).size === events.length &&
    MODEL_PLAN_WEBHOOK_EVENTS.every((event) => events.includes(event))
  )
}

/** Every complete Stripe object listing, page by page. A partial or malformed list never authorizes setup writes. */
async function stripeList(
  path: string,
  fetcher: typeof fetch,
  after?: string,
  pages = 0,
): Promise<Record<string, unknown>[]> {
  if (pages >= 50) throw new Error(`Stripe's ${path} listing did not end.`)
  const query = new URLSearchParams({ limit: "100", ...(after ? { starting_after: after } : {}) })
  const result = await setupStripe(`${path}${path.includes("?") ? "&" : "?"}${query}`, {}, fetcher)
  if (!Array.isArray(result.data) || typeof result.has_more !== "boolean" || !result.data.every(stripeRecord))
    throw new Error(`Stripe's ${path} listing could not be read completely.`)
  const data = result.data
  const last = data.at(-1)?.id
  if (!result.has_more) return data
  if (typeof last !== "string" || last === after) throw new Error(`Stripe's ${path} listing did not move on.`)
  return [...data, ...(await stripeList(path, fetcher, last, pages + 1))]
}
