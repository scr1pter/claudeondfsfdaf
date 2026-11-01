import { isPlanId } from "../../packages/schema/src/codium-plan.js"
import { ApiError } from "./http.js"
import { modelPlans } from "./model-plan-config.js"
import { listStripe, modelPlanStripe, stripeRecord } from "./model-plan-stripe.js"

/** Carry reserves in-flight spend too. The delayed true-up uses final usage after these holds settle. */
export function carryMicro(limit: number, usage: number, held = 0) {
  if (![limit, usage, held].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your remaining allowance could not be verified.")
  return Math.max(0, limit - usage - held)
}

export function changeUnavailable() {
  return new ApiError(409, "MODEL_PLAN_CHANGE_UNAVAILABLE", "Change plans on vectordev.ai/account.")
}

function stripeId(value: unknown) {
  return typeof value === "string" ? value : stripeRecord(value) && typeof value.id === "string" ? value.id : undefined
}

/** A schedule must belong to the selected subscription before it can be read or released. */
async function ownedSchedule(subscription: Record<string, unknown>, fetcher: typeof fetch) {
  const id = stripeId(subscription.schedule)
  if (!id) return undefined
  const schedule = await modelPlanStripe(`subscription_schedules/${encodeURIComponent(id)}`, {}, fetcher)
  if (
    stripeId(schedule.subscription) !== subscription.id ||
    stripeId(schedule.customer) !== stripeId(subscription.customer)
  )
    throw changeUnavailable()
  return schedule
}

export async function releaseDowngrade(subscription: Record<string, unknown>, fetcher: typeof fetch) {
  const schedule = await ownedSchedule(subscription, fetcher)
  if (!schedule || schedule.status === "released" || schedule.status === "canceled" || schedule.status === "completed")
    return
  await modelPlanStripe(
    `subscription_schedules/${encodeURIComponent(String(schedule.id))}/release`,
    {
      method: "POST",
      idempotency: `vector-release-${schedule.id}`,
      body: new URLSearchParams({ preserve_cancel_date: "true" }),
    },
    fetcher,
  )
}

export async function scheduledPlan(subscription: Record<string, unknown> | undefined, fetcher: typeof fetch) {
  if (!subscription) return undefined
  const schedule = await ownedSchedule(subscription, fetcher)
  if (!schedule || !["active", "not_started"].includes(String(schedule.status))) return undefined
  const currentItem =
    stripeRecord(subscription.items) && Array.isArray(subscription.items.data) ? subscription.items.data[0] : undefined
  const end = Number(
    stripeRecord(currentItem)
      ? (currentItem.current_period_end ?? subscription.current_period_end)
      : subscription.current_period_end,
  )
  const phase = Array.isArray(schedule.phases)
    ? schedule.phases.find((value) => stripeRecord(value) && value.start_date === end)
    : undefined
  const item = stripeRecord(phase) && Array.isArray(phase.items) ? phase.items[0] : undefined
  const price = stripeRecord(item) ? stripeId(item.price) : undefined
  const plan = modelPlans().find((value) => value.priceID === price)
  return plan && isPlanId(plan.id) ? { plan: plan.id, at: end * 1000 } : undefined
}

export async function scheduleDowngrade(
  subscription: Record<string, unknown>,
  targetPrice: string,
  token: string,
  fetcher: typeof fetch,
) {
  if (subscription.cancel_at_period_end) throw changeUnavailable()
  const item =
    stripeRecord(subscription.items) && Array.isArray(subscription.items.data) ? subscription.items.data[0] : undefined
  const price = stripeRecord(item) ? stripeId(item.price) : undefined
  const start = Number(
    stripeRecord(item) ? (item.current_period_start ?? subscription.current_period_start) : undefined,
  )
  const end = Number(stripeRecord(item) ? (item.current_period_end ?? subscription.current_period_end) : undefined)
  if (!price || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw changeUnavailable()
  const schedule =
    (await ownedSchedule(subscription, fetcher)) ??
    (await modelPlanStripe(
      "subscription_schedules",
      {
        method: "POST",
        idempotency: `vector-downgrade-create-${token}`,
        body: new URLSearchParams({ from_subscription: String(subscription.id) }),
      },
      fetcher,
    ))
  if (typeof schedule.id !== "string") throw changeUnavailable()
  await modelPlanStripe(
    `subscription_schedules/${encodeURIComponent(schedule.id)}`,
    {
      method: "POST",
      idempotency: `vector-downgrade-${schedule.id}-${targetPrice}`,
      body: new URLSearchParams({
        end_behavior: "release",
        proration_behavior: "none",
        "phases[0][start_date]": String(start),
        "phases[0][end_date]": String(end),
        "phases[0][items][0][price]": price,
        "phases[0][items][0][quantity]": "1",
        "phases[0][proration_behavior]": "none",
        "phases[1][items][0][price]": targetPrice,
        "phases[1][items][0][quantity]": "1",
        "phases[1][iterations]": "1",
        "phases[1][proration_behavior]": "none",
      }),
    },
    fetcher,
  )
}

/** Cancellation and invoice cleanup converge from current Stripe state, including retries after a lost response. */
export async function supersedeSubscription(
  customer: string,
  subscription: string,
  fetcher: typeof fetch,
  verify: () => Promise<void> = async () => {},
) {
  const old = await modelPlanStripe(`subscriptions/${encodeURIComponent(subscription)}`, {}, fetcher)
  if (stripeId(old.customer) !== customer) throw changeUnavailable()
  if (old.status !== "canceled") {
    await releaseDowngrade(old, fetcher)
    await verify()
    await modelPlanStripe(
      `subscriptions/${encodeURIComponent(subscription)}`,
      {
        method: "DELETE",
        body: new URLSearchParams({ prorate: "false", invoice_now: "false" }),
      },
      fetcher,
    )
  }
  const invoices = await listStripe(
    "invoices",
    [
      ["customer", customer],
      ["subscription", subscription],
    ],
    {},
    fetcher,
  )
  if (!invoices.complete) throw changeUnavailable()
  for (const invoice of invoices.data) {
    if (typeof invoice.id !== "string") throw changeUnavailable()
    if (invoice.status === "open") {
      await verify()
      await modelPlanStripe(
        `invoices/${encodeURIComponent(invoice.id)}/void`,
        {
          method: "POST",
          idempotency: `vector-void-${invoice.id}`,
        },
        fetcher,
      )
    }
    if (invoice.status === "draft") {
      await verify()
      await modelPlanStripe(`invoices/${encodeURIComponent(invoice.id)}`, { method: "DELETE" }, fetcher)
    }
  }
}
