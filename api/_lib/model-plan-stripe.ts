import { createHmac, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { ApiError } from "./http.js"

export const stripeRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/**
 * The Stripe events the Codium webhook acts on (contract §4.5): exactly 20, so one replay call can list them all.
 * `scripts/setup-model-plans.ts --apply` subscribes exactly these.
 */
export const MODEL_PLAN_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.created",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
  "charge.refunded",
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_reinstated",
  "radar.early_fraud_warning.created",
  "radar.early_fraud_warning.updated",
  "subscription_schedule.released",
  "subscription_schedule.canceled",
] as const
export type ModelPlanWebhookEvent = (typeof MODEL_PLAN_WEBHOOK_EVENTS)[number]

/**
 * The families of event types the webhook routes (§4.5): the prefixes of the 20 events above. A type outside them is
 * acknowledged and ignored. Within a family the webhook does the same thing for every type (reconcile from Stripe's
 * current state), so a type Stripe adds to a family later is handled too.
 */
export const MODEL_PLAN_WEBHOOK_PREFIXES = [
  "checkout.session.",
  "customer.subscription.",
  "invoice.",
  "charge.",
  "radar.early_fraud_warning.",
  "subscription_schedule.",
] as const
export const MODEL_PLAN_STRIPE_VERSION = "2025-02-24.acacia"

/** Which Stripe account Codium bills through. Every store key, snapshot and OpenRouter key name carries it. */
export type StripeMode = "live" | "test"

// A secret (`sk_`) or restricted (`rk_`) key names its own mode; publishable keys and anything else are refused.
const STRIPE_KEY = /^(?:sk|rk)_(live|test)_\w+$/

/**
 * The mode the store is namespaced by: `CODIUM_STRIPE_MODE` when it says live or test, otherwise the mode the Stripe
 * key names, otherwise test. It never throws, so a server whose billing is not configured still reads and writes
 * only the test namespace, and nothing it stores can be read as live. Whether billing may run in this mode at all is
 * `requireStripeMode()`'s question.
 */
export function stripeMode(): StripeMode {
  const configured = process.env.CODIUM_STRIPE_MODE?.trim()
  if (configured === "live" || configured === "test") return configured
  return STRIPE_KEY.exec(process.env.STRIPE_SECRET_KEY?.trim() ?? "")?.[1] === "live" ? "live" : "test"
}

/**
 * Why the configured Stripe key may not be used, as env names only (never values), for the owner and the logs. Empty
 * when the key and `CODIUM_STRIPE_MODE` agree. A live key needs `CODIUM_STRIPE_MODE=live` said out loud and runs only
 * where `VERCEL_ENV=production`, so a preview, a local checkout or CI can never charge a real card. A missing key is
 * not a mode problem: billing is simply unavailable.
 */
export function stripeModeProblems(): string[] {
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  const configured = process.env.CODIUM_STRIPE_MODE?.trim()
  const problems: string[] = []
  if (configured && configured !== "live" && configured !== "test")
    problems.push("CODIUM_STRIPE_MODE must be live or test")
  if (!key) return problems
  const named = STRIPE_KEY.exec(key)?.[1]
  if (!named) return [...problems, "STRIPE_SECRET_KEY is not a Stripe secret or restricted key"]
  if (named === "live" && !configured) problems.push("a live STRIPE_SECRET_KEY needs CODIUM_STRIPE_MODE=live")
  if (configured && (configured === "live" || configured === "test") && configured !== named)
    problems.push("CODIUM_STRIPE_MODE does not match the mode of STRIPE_SECRET_KEY")
  if (named === "live" && process.env.VERCEL_ENV !== "production")
    problems.push("a live STRIPE_SECRET_KEY runs only with VERCEL_ENV=production")
  return problems
}

/** The mode every Stripe call runs in, after the guard: refuses a missing key and any mode problem. */
export function requireStripeMode(): StripeMode {
  if (!process.env.STRIPE_SECRET_KEY?.trim())
    throw new ApiError(503, "BILLING_UNAVAILABLE", "Billing is temporarily unavailable.")
  if (stripeModeProblems().length) throw modeError()
  return stripeMode()
}

/**
 * Refuses a record written in the other mode, such as an entitlement snapshot: a live server never acts on a test
 * record, nor a test server on a live one. A record that does not say which mode it belongs to is refused too.
 */
export function requireCodiumLivemode(record: { readonly livemode?: unknown }) {
  if (record.livemode !== (stripeMode() === "live")) throw modeError()
}

function modeError() {
  return new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
}

/**
 * A Stripe request through the mode guard. Every POST names an idempotency key, so a retry after a timeout, a crash or
 * a replayed notification repeats the same Stripe write instead of making a second one.
 */
export async function modelPlanStripe(
  path: string,
  input: { method?: "GET" | "POST" | "DELETE"; body?: URLSearchParams; idempotency?: string } = {},
  fetcher: typeof fetch = fetch,
) {
  requireStripeMode()
  const key = process.env.STRIPE_SECRET_KEY!.trim()
  if ((input.method ?? "GET") === "POST" && !validIdempotencyKey(input.idempotency))
    throw new ApiError(500, "BILLING_IDEMPOTENCY_REQUIRED", "Billing could not complete this request.")
  const response = await fetcher(`https://api.stripe.com/v1/${path}`, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${key}`,
      "Stripe-Version": MODEL_PLAN_STRIPE_VERSION,
      ...(input.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(input.idempotency ? { "Idempotency-Key": input.idempotency } : {}),
    },
    body: input.body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok || !stripeRecord(body))
    throw new ApiError(502, "BILLING_UPSTREAM", "Billing could not complete this request. Please retry.")
  return body
}

/** Stripe returns at most this many objects in one page of a list. */
export const STRIPE_PAGE_SIZE = 100
/** Stripe filters one events listing by at most this many types: why the webhook subscribes exactly 20 (§4.5). */
export const STRIPE_EVENT_TYPES_MAX = 20

function upstreamError() {
  return new ApiError(502, "BILLING_UPSTREAM", "Billing could not complete this request. Please retry.")
}

/**
 * A Stripe list read page by page through the mode guard, at the pinned API version: `query` names the filters, and
 * each page continues `starting_after` the last object of the page before, so the order is Stripe's (newest first).
 * Stops when Stripe has no more, or after `maxPages`; `complete` says which. A page Stripe answers without its list
 * shape fails the whole read, so a caller never mistakes half a list for all of it.
 */
export async function listStripe(
  path: string,
  query: readonly (readonly [string, string])[],
  options: { maxPages?: number; pageSize?: number } = {},
  fetcher: typeof fetch = fetch,
): Promise<{ data: Record<string, unknown>[]; complete: boolean }> {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? 10))
  const pageSize = Math.min(STRIPE_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? STRIPE_PAGE_SIZE)))
  const data: Record<string, unknown>[] = []
  let after: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams([
      ...query.map(([name, value]): [string, string] => [name, value]),
      ["limit", String(pageSize)],
      ...(after ? [["starting_after", after] as [string, string]] : []),
    ])
    const result = await modelPlanStripe(`${path}?${params}`, {}, fetcher)
    if (!Array.isArray(result.data) || typeof result.has_more !== "boolean") throw upstreamError()
    data.push(...result.data.filter(stripeRecord))
    if (!result.has_more) return { data, complete: true }
    const last: unknown = result.data.at(-1)
    if (!stripeRecord(last) || typeof last.id !== "string" || !last.id) throw upstreamError()
    after = last.id
  }
  return { data, complete: false }
}

/** A Stripe event as an events listing returns it, rendered at the API version it was created with. */
export type StripeEvent = Record<string, unknown> & {
  id: string
  type: string
  /** Seconds since the epoch. */
  created: number
  data: Record<string, unknown> & { object: Record<string, unknown> }
}

const EVENT_ID = /^evt_[\x21-\x7e]{1,200}$/

/**
 * The events of `types` (at most 20) created from `since` to `until` (seconds, both included), newest first, read in
 * pages through `listStripe`. Events without an id, a type, a creation time or an object are left out: nothing could
 * route them. `complete` is false when the window held more than `maxPages` pages, and then only the newest are here.
 */
export async function listStripeEvents(
  options: { types: readonly string[]; since: number; until: number; maxPages?: number; pageSize?: number },
  fetcher: typeof fetch = fetch,
): Promise<{ events: StripeEvent[]; complete: boolean }> {
  const { types, since, until } = options
  if (
    !types.length ||
    types.length > STRIPE_EVENT_TYPES_MAX ||
    !Number.isSafeInteger(since) ||
    !Number.isSafeInteger(until) ||
    since < 0 ||
    since > until
  )
    throw new ApiError(500, "BILLING_EVENTS_INVALID", "Billing events could not be listed.")
  const listed = await listStripe(
    "events",
    [
      ...types.map((type): [string, string] => ["types[]", type]),
      ["created[gte]", String(since)],
      ["created[lte]", String(until)],
    ],
    { maxPages: options.maxPages, pageSize: options.pageSize },
    fetcher,
  )
  const wanted = new Set(types)
  const events = listed.data.filter(
    (event): event is StripeEvent =>
      typeof event.id === "string" &&
      EVENT_ID.test(event.id) &&
      typeof event.type === "string" &&
      wanted.has(event.type) &&
      Number.isSafeInteger(event.created) &&
      stripeRecord(event.data) &&
      stripeRecord(event.data.object),
  )
  return { events, complete: listed.complete }
}

export function verifyModelPlanWebhook(raw: Buffer, signature: string, now = Date.now()) {
  const secret = process.env.STRIPE_MODEL_PLAN_WEBHOOK_SECRET?.trim()
  if (!secret) throw new ApiError(503, "WEBHOOK_UNAVAILABLE", "Billing notifications are not configured.")
  const parts = signature.split(",").map((part) => part.trim().split("="))
  const timestamp = parts.find(([name]) => name === "t")?.[1] ?? ""
  const expected = createHmac("sha256", secret).update(timestamp).update(".").update(raw).digest()
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !parts.some(
      ([name, value]) =>
        name === "v1" &&
        typeof value === "string" &&
        /^[a-fA-F0-9]{64}$/.test(value) &&
        timingSafeEqual(Buffer.from(value, "hex"), expected),
    )
  )
    throw new ApiError(400, "WEBHOOK_SIGNATURE", "Invalid billing notification signature.")
  const event = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw.toString("utf8"))
  if (Option.isNone(event) || !stripeRecord(event.value) || typeof event.value.type !== "string")
    throw new ApiError(400, "WEBHOOK_INVALID", "Invalid billing notification.")
  // Each mode has its own endpoint and secret, so an event from the other mode means a secret was configured in the
  // wrong place. Acting on it would reconcile test objects with a live key, or the reverse.
  if (typeof event.value.livemode === "boolean" && event.value.livemode !== (stripeMode() === "live"))
    throw new ApiError(400, "WEBHOOK_MODE", "This billing notification is for the other Stripe mode.")
  return event.value
}

/** Stripe accepts keys of up to 255 characters; Codium's are printable ASCII without spaces. */
export function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,255}$/.test(value)
}
