import { checkCodiumFunding, CODIUM_FUNDING_MAX_AGE_MS, readCodiumFunding } from "./codium-funding.js"
import { rememberCollectionInvoice } from "./codium-collection.js"
import { codiumKeyLimitUsd } from "./codium-limits.js"
import { notifyOwner } from "./codium-owner.js"
import { enqueueAction, registerAction } from "./codium-provision.js"
import { readSwitch } from "./codium-switches.js"
import { ApiError } from "./http.js"
import {
  accountForCustomer,
  governingStanding,
  listSubscriptions,
  readModelPlanAccount,
  riskState,
  subscriptionStanding,
  withCodiumLease,
  type Standing,
} from "./model-plan-account.js"
import { modelPlans, modelPlansEnabled, subscriptionPlanCredits } from "./model-plan-config.js"
import { modelPlanStripe, stripeRecord } from "./model-plan-stripe.js"

/*
 * Renewals (contract §4.4 "Renewal", §4.5, invariants M7 and M11). At the end of a period Stripe moves the subscription
 * on and creates the renewal invoice as a draft (`invoice.created`, billing reason `subscription_cycle`). The webhook
 * queues the outbox action `finalize-renewal` for it, keyed by the invoice. The action finalizes and pays the invoice at
 * once, so the paying subscriber's next month starts within a minute instead of Stripe's hour, but only when Vector
 * should take that charge (M7):
 *
 * - the `codium` service is on (`MODEL_PLANS_ENABLED` and the `codium` runtime switch);
 * - the account is not frozen, blocked or closing;
 * - the subscription is not superseded by an upgrade, and is the account's governing one (not a duplicate);
 * - nobody has paused its collection;
 * - Vector's OpenRouter balance covers what is owed plus this renewal's credits.
 *
 * Otherwise it skips the early charge and tells the owner. For a frozen, superseded, duplicate or codium-off account it
 * also pauses collection (`pause_collection[behavior]=void`, marked `metadata[vector_paused_for]`) and stops the draft
 * from advancing (`auto_advance=false`), so Stripe does not take the charge an hour later either. Whoever lifts that
 * pause (the dispute's win, WP A10; the `codium` switch coming back, WP A11) queues `finalize-renewal` for the invoice
 * again. A balance that falls short only skips the early charge: renewals continue while sales are paused (M12), and
 * Stripe collects the invoice on its own schedule.
 *
 * Meanwhile the account is `renewing`, and the previous period's key keeps serving until the period's end plus the
 * renewal grace (M11, model-plan-account.ts). When the renewal is paid, reconcile gives the account the next period's
 * key at full credits, with no carry and a new meter epoch, and switches the old key off.
 */

/** Why a renewal was not charged early. */
export const RENEWAL_REFUSALS = [
  "codium-off",
  "frozen",
  "superseded",
  "not-governing",
  "collection-paused",
  "unfunded",
] as const
export type RenewalRefusal = (typeof RENEWAL_REFUSALS)[number]

/** Refusals where Vector must not take the charge at all, so collection is paused, not merely left to Stripe. */
const PAUSES: ReadonlySet<RenewalRefusal> = new Set(["codium-off", "frozen", "superseded", "not-governing"])

export type RenewalOutcome =
  /** Finalized and paid now. */
  | { outcome: "paid"; invoice: string; account: string }
  /** Finalized, and the card was declined or needs the customer: Stripe's retries and emails take over (`past_due`). */
  | { outcome: "payment-failed"; invoice: string; account: string }
  /** Not charged early, for `reason`; `paused` when collection was paused too. */
  | { outcome: "refused"; invoice: string; account: string; reason: RenewalRefusal; paused: boolean }
  /** Nothing to do: not a renewal, already finalized and attempted, paid or void, or not a Codium account's invoice. */
  | { outcome: "skipped"; invoice: string; why: "not-renewal" | "settled" | "not-codium" }

const INVOICE_ID = /^in_[A-Za-z0-9]+$/
const OWNER_ALERT_KEEP_MS = 35 * 86_400_000

/** Whether an id is a Stripe invoice id, which is also the action's key. */
export const renewalInvoiceId = (value: unknown): value is string => typeof value === "string" && INVOICE_ID.test(value)

/**
 * Queues `finalize-renewal` for the invoice an `invoice.created` notification names (contract §4.5). The webhook answers
 * 200 whether or not this succeeds, so Stripe's own schedule is never held up by Vector's store; replay (WP A08) queues
 * any it missed. Returns false when the notification names no invoice.
 */
export async function queueRenewal(invoice: Record<string, unknown>, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (!renewalInvoiceId(invoice.id)) return false
  const customer = typeof invoice.customer === "string" ? invoice.customer : undefined
  await enqueueAction("finalize-renewal", invoice.id, customer ? { customer } : {}, undefined, fetcher, now)
  return true
}

/** An invoice Vector may still collect: a draft, or finalized without a payment attempt yet. */
function collectable(invoice: Record<string, unknown>) {
  return invoice.status === "draft" || (invoice.status === "open" && Number(invoice.attempt_count ?? 0) === 0)
}

async function readInvoice(id: string, fetcher: typeof fetch) {
  const invoice = await modelPlanStripe(`invoices/${encodeURIComponent(id)}`, {}, fetcher)
  if (invoice.id !== id)
    throw new ApiError(502, "BILLING_UPSTREAM", "Billing could not complete this request. Please retry.")
  return invoice
}

const idOf = (value: unknown) =>
  typeof value === "string" ? value : stripeRecord(value) && typeof value.id === "string" ? value.id : undefined

/**
 * The outbox action `finalize-renewal` (contract §4.4): finalizes and pays the renewal invoice `invoiceId` when M7's
 * guards hold, or refuses as described at the top of this module. Every Stripe write names an idempotency key
 * (`vector-finalize-<in>`, `vector-pay-<in>`, and for a refusal `vector-pause-<in>-<reason>-<hour>` and
 * `vector-hold-<in>-<hour>`), so a retried action repeats the same writes. The refusal's keys carry the hour: setting a
 * pause is the same write whenever it is repeated, and a pause someone lifted is set again later instead of answered
 * from Stripe's record of the first one. Runs under the account's lease, so it never races reconcile or an upgrade's
 * supersede.
 */
export async function finalizeRenewal(
  invoiceId: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RenewalOutcome> {
  if (!renewalInvoiceId(invoiceId))
    throw new ApiError(500, "CODIUM_RENEWAL_INVALID", "This Vector Codium renewal could not be read.")
  const skipped = (why: "not-renewal" | "settled" | "not-codium"): RenewalOutcome => ({
    outcome: "skipped",
    invoice: invoiceId,
    why,
  })
  const first = await readInvoice(invoiceId, fetcher)
  if (first.billing_reason !== "subscription_cycle") return skipped("not-renewal")
  if (!collectable(first)) return skipped("settled")
  const customer = idOf(first.customer)
  const subscription = idOf(first.subscription)
  if (!customer || !subscription) return skipped("not-codium")
  const account = await accountForCustomer(customer, fetcher)
  if (!account) return skipped("not-codium")
  return withCodiumLease(
    account,
    async (verify) => {
      const record = await readModelPlanAccount(account, fetcher)
      if (!record || record.customer !== customer) return skipped("not-codium")
      // Read again under the lease: Stripe, the owner or an earlier try may have moved it on meanwhile.
      const invoice = await readInvoice(invoiceId, fetcher)
      if (!collectable(invoice)) return skipped("settled")
      const listed = await listSubscriptions(customer, fetcher)
      const raw = listed.find((value) => value.id === subscription)
      const standings = listed.flatMap((value) => subscriptionStanding(value, account, now) ?? [])
      const own = standings.find((value) => value.id === subscription)
      // A subscription that is not this account's Codium plan is not Vector's to charge or pause.
      if (!raw || !own) return skipped("not-codium")
      const reason = await refusal({ record, raw, own, standings, fetcher, now })
      if (reason) {
        const paused = PAUSES.has(reason) && (await stopCollection(account, invoice, raw, reason, verify, fetcher, now))
        await alertOwner(account, subscription, invoiceId, reason, paused, fetcher)
        return { outcome: "refused", invoice: invoiceId, account, reason, paused }
      }
      if (invoice.status === "draft") {
        await verify()
        await modelPlanStripe(
          `invoices/${encodeURIComponent(invoiceId)}/finalize`,
          {
            method: "POST",
            idempotency: `vector-finalize-${invoiceId}`,
            body: new URLSearchParams({ auto_advance: "true" }),
          },
          fetcher,
        )
      }
      await verify()
      const outcome = await modelPlanStripe(
        `invoices/${encodeURIComponent(invoiceId)}/pay`,
        { method: "POST", idempotency: `vector-pay-${invoiceId}` },
        fetcher,
      ).then(
        () => "paid" as const,
        async (error: unknown) => {
          // A declined card answers an error too. What Stripe now holds says which it was.
          const after = await readInvoice(invoiceId, fetcher)
          if (after.status === "paid") return "paid" as const
          if (after.status === "open" && Number(after.attempt_count ?? 0) > 0) return "payment-failed" as const
          throw error
        },
      )
      // The new period's key, or the paused state, without waiting for Stripe's notification.
      await enqueueAction("reconcile", account, {}, undefined, fetcher, now)
      return { outcome, invoice: invoiceId, account }
    },
    fetcher,
  )
}

/** The first of M7's guards that refuses this renewal, in the order the contract names them, or undefined. */
async function refusal(input: {
  record: NonNullable<Awaited<ReturnType<typeof readModelPlanAccount>>>
  raw: Record<string, unknown>
  own: Standing
  standings: readonly Standing[]
  fetcher: typeof fetch
  now: number
}): Promise<RenewalRefusal | undefined> {
  const { record, raw, own, standings, fetcher, now } = input
  if (!modelPlansEnabled() || (await readSwitch("codium", fetcher, { fresh: true })) === "off") return "codium-off"
  // A dispute, a fraud warning, a block or a deletion holds the account whatever Stripe says.
  if (riskState(record)) return "frozen"
  if (standings.some((value) => value.supersedes === own.id && value.state !== "none")) return "superseded"
  if (governingStanding(standings).governing?.id !== own.id) return "not-governing"
  if (raw.pause_collection !== null && raw.pause_collection !== undefined) return "collection-paused"
  const metadata = stripeRecord(raw.metadata) ? raw.metadata : undefined
  const credits = subscriptionPlanCredits(
    metadata,
    modelPlans().find((plan) => plan.id === own.plan),
  )
  if (!(await renewalFunded(credits, fetcher, now))) return "unfunded"
  return undefined
}

/**
 * Whether Vector's OpenRouter balance covers what customers are owed now plus this renewal's credits, by a funding
 * reading from the last CODIUM_FUNDING_MAX_AGE_MS (one is taken when the saved one is older). No reading, or one that
 * cannot be read or is dated after `now`, counts as short: the early charge is skipped and Stripe collects on its
 * own schedule. A clock rollback must not extend the life of a saved funding reading.
 */
async function renewalFunded(credits: number | undefined, fetcher: typeof fetch, now: number) {
  if (credits === undefined || !Number.isFinite(credits) || credits <= 0) return false
  const saved = await readCodiumFunding(fetcher).catch(() => undefined)
  const funding =
    saved && saved.checkedAt <= now && now - saved.checkedAt < CODIUM_FUNDING_MAX_AGE_MS
      ? saved
      : await checkCodiumFunding(fetcher, now).catch(() => undefined)
  if (
    !funding ||
    typeof funding.checkedAt !== "number" ||
    funding.checkedAt > now ||
    now - funding.checkedAt >= CODIUM_FUNDING_MAX_AGE_MS ||
    typeof funding.balance !== "number" ||
    typeof funding.owed !== "number"
  )
    return false
  return funding.balance >= funding.owed + Math.round(codiumKeyLimitUsd(credits) * 100)
}

/**
 * Pauses the subscription's collection (void) and holds the draft or unattempted invoice, so neither Vector nor Stripe
 * takes this charge. Returns whether collection is paused now.
 */
async function stopCollection(
  account: string,
  invoice: Record<string, unknown>,
  subscription: Record<string, unknown>,
  reason: RenewalRefusal,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
  now: number,
) {
  const id = String(invoice.id)
  await rememberCollectionInvoice(account, String(subscription.id), id, verify, fetcher)
  const hour = Math.floor(now / 3_600_000)
  const pausable = ["active", "past_due", "unpaid", "trialing"].includes(String(subscription.status))
  const pause = stripeRecord(subscription.pause_collection) ? subscription.pause_collection : undefined
  if (pausable && !subscription.pause_collection) {
    await verify()
    await modelPlanStripe(
      `subscriptions/${encodeURIComponent(String(subscription.id))}`,
      {
        method: "POST",
        idempotency: `vector-pause-${id}-${reason}-${hour}`,
        body: new URLSearchParams({ "pause_collection[behavior]": "void", "metadata[vector_paused_for]": reason }),
      },
      fetcher,
    )
  }
  if (invoice.auto_advance !== false) {
    await verify()
    await modelPlanStripe(
      `invoices/${encodeURIComponent(id)}`,
      {
        method: "POST",
        idempotency: `vector-hold-${id}-${hour}`,
        body: new URLSearchParams({ auto_advance: "false" }),
      },
      fetcher,
    )
  }
  return (pausable && !subscription.pause_collection) || pause?.behavior === "void"
}

const REFUSAL_LINES: Record<RenewalRefusal, string> = {
  "codium-off":
    "Vector Codium is switched off (MODEL_PLANS_ENABLED or the codium switch), so the renewal is not charged.",
  frozen: "The account is on hold (a dispute, a fraud warning, a block or deletion), so the renewal is not charged.",
  superseded: "An upgrade superseded this subscription, so its renewal is not charged.",
  "not-governing": "Another subscription governs this account; this one is a duplicate, so its renewal is not charged.",
  "collection-paused": "Collection on this subscription is already paused, so Vector left the renewal alone.",
  unfunded:
    "Vector's OpenRouter balance does not cover what is owed plus this renewal, so Vector did not charge it early. Stripe collects it on its own schedule; top up OpenRouter.",
}

/** Tells the owner, once per invoice and reason, by ids only. A failed send does not fail the renewal's handling. */
async function alertOwner(
  account: string,
  subscription: string,
  invoice: string,
  reason: RenewalRefusal,
  paused: boolean,
  fetcher: typeof fetch,
) {
  const result = await notifyOwner(
    {
      kind: `renewal:${invoice}:${reason}`,
      subject: "Vector Codium: a renewal was not charged early",
      lines: [
        REFUSAL_LINES[reason],
        "",
        `Account: ${account}`,
        `Subscription: ${subscription}`,
        `Invoice: ${invoice}`,
        paused
          ? "Collection on the subscription is paused (void) and the invoice is held as it is. Whoever lifts the pause queues finalize-renewal for this invoice again."
          : "Nothing was changed in Stripe.",
      ],
      dedupeMs: OWNER_ALERT_KEEP_MS,
    },
    fetcher,
  ).catch(() => "failed" as const)
  if (result === "failed") console.warn("Vector Codium: a renewal alert could not be sent", { invoice, reason })
}

// `finalize-renewal` (key: the renewal invoice's id; payload `{customer?}`): queued by the webhook's `invoice.created`.
registerAction("finalize-renewal", async (action, fetcher) => {
  await finalizeRenewal(action.key, fetcher, action.now)
})
