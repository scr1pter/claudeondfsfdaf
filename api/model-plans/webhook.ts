import { recordCodiumCharge } from "../_lib/codium-ledger.js"
import { codiumKey } from "../_lib/codium-keys.js"
import { enqueueAction } from "../_lib/codium-provision.js"
import { queueRenewal } from "../_lib/codium-renewal.js"
import type { SnapshotSource } from "../_lib/codium-snapshot.js"
import { accountForCustomer, reconcileModelPlanAccount, type ReconcileHint } from "../_lib/model-plan-account.js"
import {
  MODEL_PLAN_WEBHOOK_PREFIXES,
  modelPlanStripe,
  stripeRecord,
  verifyModelPlanWebhook,
} from "../_lib/model-plan-stripe.js"
import { persistentStore } from "../_lib/persistent-store.js"
import {
  ApiError,
  handleApiError,
  json,
  readRawBody,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"

export const config = { api: { bodyParser: false } }

/*
 * The Stripe webhook (contract §4.5). Every notification is acted on the same way: verify its signature over the raw
 * body, find the Vector account it is about, and reconcile that account from Stripe's current state, never from the
 * notification's own copy of an object. A replayed, late or out-of-order notification therefore changes nothing, and
 * side effects are deduplicated by the snapshot's version, not by the event's id. Order:
 *
 * 1. verify the signature (400 when it is wrong);
 * 2. `invoice.created`: queue `finalize-renewal` (codium-renewal.ts) and answer 200, even when the store is down, so
 *    Stripe's own renewal schedule never waits on Vector;
 * 3. otherwise reconcile within an 8 s budget. On success, mark the event done (`stripe:event:<evt>`, 35 days, which
 *    replay skips) and answer 200. On failure, queue a durable `reconcile` for the account and answer 200 when that was
 *    stored, else 500 so Stripe sends it again.
 *
 * A notification is routed by its type, its object's id, its customer and the charge it hangs off. Objects whose
 * notification leaves the charge out (an invoice at a newer API version) are read again by id at the pinned version.
 */

/** Reconcile, and the private ledger after it, must finish within this budget; otherwise the work is queued. */
export const WEBHOOK_BUDGET_MS = 8_000
/** How long a done marker is kept: longer than Stripe retries a notification (3 days) and replay looks back. */
export const EVENT_DONE_KEEP_MS = 35 * 86_400_000

/** Whether the webhook routes this event type: the families of the 20 events it subscribes to (§4.5). */
export function routedEvent(type: string) {
  return MODEL_PLAN_WEBHOOK_PREFIXES.some((prefix) => type.startsWith(prefix))
}

/** `stripe:event:<evt>`: the done marker replay (WP A08) reads before it handles an event again. */
export const eventDoneKey = (event: string) => codiumKey("stripe", "event", event)

const EVENT_ID = /^evt_[\x21-\x7e]{1,200}$/
const CHARGE_ID = /^(ch|py)_[a-zA-Z0-9]+$/

/** What a notification is about: the account, the dispute or warning reconcile must read again, and the ledger's charge. */
export type EventSubject = { account: string; hint?: ReconcileHint; charge?: string }

const idOf = (value: unknown) =>
  typeof value === "string" ? value : stripeRecord(value) && typeof value.id === "string" ? value.id : undefined

function eventObject(event: Record<string, unknown>) {
  return stripeRecord(event.data) && stripeRecord(event.data.object) ? event.data.object : undefined
}

/** A Stripe object id as the notification names it: letters, digits and underscores only. */
const OBJECT_ID = /^[A-Za-z0-9_]{1,255}$/

/**
 * The charge and customer a notification's object belongs to. A charge is its own id. A dispute, a refund, an
 * early-fraud warning and an invoice name the charge they hang off; when the notification's API version leaves that
 * field out (a newer version moved an invoice's charge elsewhere), the object is read again by its id at the pinned
 * version. Everything else names its customer. Reconcile itself never trusts the notification's copy of an object.
 */
async function subjectObject(
  type: string,
  object: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<{ charge?: string; customer?: string }> {
  const id = typeof object.id === "string" && OBJECT_ID.test(object.id) ? object.id : undefined
  const customer = idOf(object.customer)
  const linked = async (path: string) => {
    if ("charge" in object) return { charge: idOf(object.charge), customer }
    const fresh = id ? await modelPlanStripe(`${path}/${encodeURIComponent(id)}`, {}, fetcher) : undefined
    return { charge: idOf(fresh?.charge), customer: customer ?? idOf(fresh?.customer) }
  }
  if (type.startsWith("charge.dispute.")) return linked("disputes")
  if (type.startsWith("charge.refund.")) return linked("refunds")
  if (type.startsWith("radar.early_fraud_warning.")) return linked("radar/early_fraud_warnings")
  if (type.startsWith("charge.")) return { charge: id, customer }
  if (type.startsWith("invoice.")) return linked("invoices")
  return { customer }
}

/**
 * Finds what a notification is about, reading Stripe for anything the notification does not name: the charge of a
 * dispute, refund, warning or invoice, the customer of a charge, and the Vector account of a customer. Undefined when
 * the event is not one the webhook routes, or not about a Codium account.
 */
export async function eventSubject(
  event: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<EventSubject | undefined> {
  const type = String(event.type)
  const object = eventObject(event)
  if (!object || !routedEvent(type) || type === "invoice.created") return undefined
  const found = await subjectObject(type, object, fetcher)
  const charge = found.charge && CHARGE_ID.test(found.charge) ? found.charge : undefined
  const customer =
    found.customer ??
    (charge ? idOf((await modelPlanStripe(`charges/${encodeURIComponent(charge)}`, {}, fetcher)).customer) : undefined)
  if (!customer) return undefined
  const account = await accountForCustomer(customer, fetcher)
  if (!account) return undefined
  // A dispute or fraud warning on a charge no subscription points at any more (last month's) is named to reconcile,
  // which reads it again from Stripe.
  const hint: ReconcileHint | undefined = type.startsWith("charge.dispute.")
    ? charge
      ? { kind: "dispute", charge }
      : undefined
    : type.startsWith("radar.early_fraud_warning.") && typeof object.id === "string" && OBJECT_ID.test(object.id)
      ? { kind: "efw", id: object.id, ...(charge ? { charge } : {}) }
      : undefined
  return { account, ...(hint ? { hint } : {}), ...(charge ? { charge } : {}) }
}

/**
 * Handles one notification without a time budget, throwing when any step fails: reconcile, then the private ledger for
 * the charge it names, or, for `invoice.created`, the renewal queued. Replay (WP A08) and the tests use this; the route
 * itself uses `handleModelPlanEvent`.
 */
export async function reconcileModelPlanEvent(
  event: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  options: { now?: number; source?: SnapshotSource } = {},
) {
  const now = options.now ?? Date.now()
  if (String(event.type) === "invoice.created") {
    const object = eventObject(event)
    if (object) await queueRenewal(object, fetcher, now)
    return
  }
  const subject = await eventSubject(event, fetcher)
  if (!subject) return
  await reconcileModelPlanAccount(subject.account, fetcher, now, {
    source: options.source ?? "webhook",
    ...(subject.hint ? { hint: subject.hint } : {}),
  })
  // The private profit ledger rewrites the charge's entry from Stripe's current state on each notification about it.
  if (subject.charge) await recordCodiumCharge(subject.account, subject.charge, fetcher)
}

export type WebhookOutcome =
  /** Reconciled (and the ledger written); marked done. */
  | { outcome: "done"; account: string }
  /** Not an event the webhook routes, or not about a Codium account; marked done. */
  | { outcome: "ignored" }
  /** Reconcile failed or ran out of time; a durable `reconcile` is queued for the account. */
  | { outcome: "queued"; account: string }
  /** Reconciled, but the ledger could not be written; not marked done, so replay writes it. */
  | { outcome: "ledger-pending"; account: string }
  /** `invoice.created`: `finalize-renewal` queued, or not (the store is down; replay queues it). */
  | { outcome: "renewal-queued" | "renewal-deferred" }

/** The route's work for one verified notification, in the order of contract §4.5. Throws only for a 500. */
export async function handleModelPlanEvent(
  event: Record<string, unknown>,
  options: { fetcher?: typeof fetch; now?: number; budgetMs?: number } = {},
): Promise<WebhookOutcome> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  const deadline = Date.now() + (options.budgetMs ?? WEBHOOK_BUDGET_MS)
  const type = String(event.type)
  if (type === "invoice.created") {
    const object = eventObject(event)
    const queued = await (object ? queueRenewal(object, fetcher, now) : Promise.resolve(false)).catch(
      (error: unknown) => {
        console.warn("Vector Codium: a renewal could not be queued", { event: event.id, error: describe(error) })
        return undefined
      },
    )
    if (queued === undefined) return { outcome: "renewal-deferred" }
    await markDone(event, fetcher, now)
    return queued ? { outcome: "renewal-queued" } : { outcome: "ignored" }
  }
  if (!routedEvent(type)) {
    await markDone(event, fetcher, now)
    return { outcome: "ignored" }
  }
  // Until the account is known nothing can be queued for it, so a failure here asks Stripe to send the event again.
  const subject = await withinBudget(eventSubject(event, fetcher), deadline).catch((error: unknown) => {
    throw retryLater(error)
  })
  if (!subject) {
    await markDone(event, fetcher, now)
    return { outcome: "ignored" }
  }
  const reconciled = await withinBudget(
    reconcileModelPlanAccount(subject.account, fetcher, now, {
      source: "webhook",
      ...(subject.hint ? { hint: subject.hint } : {}),
    }),
    deadline,
  ).then(
    () => true,
    (error: unknown) => {
      console.warn("Vector Codium: a notification's reconcile is queued", { event: event.id, error: describe(error) })
      return false
    },
  )
  if (!reconciled) {
    await enqueueAction(
      "reconcile",
      subject.account,
      subject.hint ? { hint: subject.hint } : {},
      undefined,
      fetcher,
      now,
    ).catch((error: unknown) => {
      throw retryLater(error)
    })
    return { outcome: "queued", account: subject.account }
  }
  if (subject.charge) {
    const written = await withinBudget(recordCodiumCharge(subject.account, subject.charge, fetcher), deadline).then(
      () => true,
      (error: unknown) => {
        console.warn("Vector Codium: a ledger entry waits for replay", { event: event.id, error: describe(error) })
        return false
      },
    )
    if (!written) return { outcome: "ledger-pending", account: subject.account }
  }
  await markDone(event, fetcher, now)
  return { outcome: "done", account: subject.account }
}

/** Marks an event handled, for replay. Best effort: a lost marker only means replay handles the event once more. */
async function markDone(event: Record<string, unknown>, fetcher: typeof fetch, now: number) {
  if (typeof event.id !== "string" || !EVENT_ID.test(event.id)) return
  await persistentStore(["SET", eventDoneKey(event.id), String(now), "PX", EVENT_DONE_KEEP_MS], fetcher).catch(
    () => undefined,
  )
}

/** `work`, or a refusal once `deadline` passes. Work that is still running carries on; its late failure is dropped. */
async function withinBudget<T>(work: Promise<T>, deadline: number): Promise<T> {
  work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ApiError(503, "WEBHOOK_BUDGET", "The billing notification took too long.")),
      Math.max(0, deadline - Date.now()),
    )
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

function retryLater(cause: unknown) {
  console.warn("Vector Codium: a notification is left for Stripe to send again", { error: describe(cause) })
  return new ApiError(
    500,
    "WEBHOOK_RETRY",
    "The billing notification could not be handled now. Stripe will send it again.",
  )
}

/** An error's code or name only, for the logs: never a value from the request. */
function describe(error: unknown) {
  return error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown"
}

export default async function handler(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "POST")
    const event = verifyModelPlanWebhook(
      await readRawBody(request, 1_000_000),
      String(request.headers["stripe-signature"] ?? ""),
    )
    await handleModelPlanEvent(event, { fetcher })
    json(response, 200, { received: true })
  } catch (error) {
    handleApiError(response, error)
  }
}
