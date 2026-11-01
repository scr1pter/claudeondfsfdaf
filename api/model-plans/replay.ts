import { timingSafeEqual } from "node:crypto"
import { codiumKey } from "../_lib/codium-keys.js"
import { notifyOwner } from "../_lib/codium-owner.js"
import { enqueueAction, OUTBOX_SCRIPTS } from "../_lib/codium-provision.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import {
  listStripeEvents,
  MODEL_PLAN_WEBHOOK_EVENTS,
  modelPlanStripe,
  type StripeEvent,
} from "../_lib/model-plan-stripe.js"
import { persistentStore } from "../_lib/persistent-store.js"
import { EVENT_DONE_KEEP_MS, eventDoneKey, eventSubject, reconcileModelPlanEvent } from "./webhook.js"

export const maxDuration = 60

/*
 * Replay (contract §4.5, §4.19, WP A08): every 10 minutes, the Stripe events the webhook subscribes to are listed from
 * the replay cursor less 5 minutes, and each one without a done marker (`stripe:event:<evt>`, set by the webhook and by
 * replay) is handled again: its object is read again at the pinned API version, the account it is about is reconciled
 * from Stripe's current state, its charge's ledger entry is rewritten, and an `invoice.created` queues its renewal. So a
 * notification Stripe never delivered, or one the webhook could not finish, is handled within the next run, and one that
 * was handled is never applied twice: the done markers skip it, and reconcile itself changes nothing it already changed.
 *
 * Events are handled oldest first. The cursor (`stripe:cursor`, seconds) moves up to the first event that could not be
 * handled, or to the end of the window when all were, and never moves back. An event that keeps failing is retried on
 * each run, with a durable `reconcile` queued for its account, and the owner is told once it is an hour old; after three
 * days (Stripe's own retry window) the window no longer reaches it.
 */

const DAY_S = 86_400
/** Each run looks back this far before the cursor: an event Stripe lists late is still found on the next run. */
export const REPLAY_OVERLAP_S = 300
/** The cron's window never reaches further back than this, cursor or not: Stripe's own retry window. */
export const REPLAY_LOOKBACK_S = 3 * DAY_S
/** Stripe keeps events this long; an owner's replay from an earlier time starts here. */
export const STRIPE_EVENTS_KEPT_S = 30 * DAY_S
export const REPLAY_BUDGET_MS = 50_000
/** Pages of 100 events one run reads at most. More than that in one window is reported to the owner. */
const REPLAY_MAX_PAGES = 50
const CURSOR_KEEP_MS = 35 * DAY_S * 1000
/** A failure on an event older than this is reported to the owner, once per event. */
const ALERT_AFTER_S = 3_600
const ALERT_KEEP_MS = 3 * DAY_S * 1000
const MARKER_BATCH = 100

/** `stripe:cursor`: the creation time (seconds) up to which every event was handled. */
export const replayCursorKey = () => codiumKey("stripe", "cursor")

/**
 * Where each event family's object is read again, at the pinned API version. The more specific prefixes come first.
 * `invoice.created` is not read again: queuing its renewal needs only its id and customer, and the renewal action reads
 * the invoice itself.
 */
const OBJECT_PATHS: readonly (readonly [string, string])[] = [
  ["checkout.session.", "checkout/sessions"],
  ["customer.subscription.", "subscriptions"],
  ["invoice.", "invoices"],
  ["charge.dispute.", "disputes"],
  ["charge.refund.", "refunds"],
  ["charge.", "charges"],
  ["radar.early_fraud_warning.", "radar/early_fraud_warnings"],
  ["subscription_schedule.", "subscription_schedules"],
]
const OBJECT_ID = /^[A-Za-z0-9_]{1,255}$/

export type ReplayResult = {
  /** Events in the window. */
  listed: number
  /** Events already handled (a done marker), skipped. */
  skipped: number
  /** Events handled now, and marked done. */
  handled: number
  /** Events that failed, to be tried again on the next run. */
  failed: number
  /** Events the run's time budget did not reach. */
  left: number
  /** Whether the window was listed in full (false: more than one run reads, reported to the owner). */
  complete: boolean
}

/**
 * One replay run (the cron's, or the owner's from `since`, in seconds). The cron's run starts at the cursor less
 * REPLAY_OVERLAP_S, never more than REPLAY_LOOKBACK_S back, and moves the cursor; an owner's run from `since` reaches
 * back as far as Stripe keeps events and leaves the cursor alone, so it can never skip events the cron has not handled.
 */
export async function replayStripeEvents(
  options: {
    fetcher?: typeof fetch
    now?: number
    budgetMs?: number
    since?: number
    maxPages?: number
    pageSize?: number
  } = {},
): Promise<ReplayResult> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  const deadline = Date.now() + (options.budgetMs ?? REPLAY_BUDGET_MS)
  const until = Math.floor(now / 1000)
  const owner = options.since !== undefined
  if (owner && (!Number.isSafeInteger(options.since) || options.since! < 0))
    throw new ApiError(400, "REPLAY_SINCE_INVALID", "Choose when the replay starts, in seconds.")
  const cursor = owner ? undefined : await readCursor(fetcher)
  const since = owner
    ? Math.min(until, Math.max(options.since!, until - STRIPE_EVENTS_KEPT_S))
    : Math.min(until, Math.max((cursor ?? 0) - REPLAY_OVERLAP_S, until - REPLAY_LOOKBACK_S))
  const listing = await listStripeEvents(
    {
      types: MODEL_PLAN_WEBHOOK_EVENTS,
      since,
      until,
      maxPages: options.maxPages ?? REPLAY_MAX_PAGES,
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    },
    fetcher,
  )
  // Oldest first, so the cursor can move up to the first event not handled.
  const events = [...listing.events].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const done = await doneEvents(
    events.map((event) => event.id),
    fetcher,
  )
  const result: ReplayResult = {
    listed: events.length,
    skipped: 0,
    handled: 0,
    failed: 0,
    left: 0,
    complete: listing.complete,
  }
  let frontier: number | undefined
  for (const [index, event] of events.entries()) {
    if (done.has(event.id)) {
      result.skipped++
      continue
    }
    if (Date.now() >= deadline) {
      frontier ??= event.created
      result.left = events.slice(index).filter((value) => !done.has(value.id)).length
      break
    }
    if (await replayEvent(event, fetcher, now, until)) result.handled++
    else {
      result.failed++
      frontier ??= event.created
    }
  }
  if (!listing.complete) await reportOverflow(since, until, fetcher)
  // A window listed only in part leaves the cursor where it was: its oldest events were not reached.
  else if (!owner)
    await persistentStore(
      ["EVAL", OUTBOX_SCRIPTS.RAISE, 1, replayCursorKey(), frontier ?? until, CURSOR_KEEP_MS],
      fetcher,
    )
  return result
}

/** The cursor, or undefined when there is none yet or it cannot be read (the window then reaches the full lookback). */
async function readCursor(fetcher: typeof fetch) {
  const stored = await persistentStore(["GET", replayCursorKey()], fetcher)
  if (stored === null || stored === undefined) return undefined
  const value = Number(stored)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** The ids among `ids` that carry a done marker. */
async function doneEvents(ids: readonly string[], fetcher: typeof fetch) {
  const done = new Set<string>()
  for (let start = 0; start < ids.length; start += MARKER_BATCH) {
    const batch = ids.slice(start, start + MARKER_BATCH)
    const values = await persistentStore(["MGET", ...batch.map(eventDoneKey)], fetcher)
    if (!Array.isArray(values) || values.length !== batch.length)
      throw new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected account services are temporarily unavailable.")
    batch.forEach((id, index) => {
      if (values[index] !== null && values[index] !== undefined) done.add(id)
    })
  }
  return done
}

/**
 * The event as the webhook would have received it at the pinned API version: its object read again by id, so an event
 * rendered at a newer version (whose fields may have moved) routes on the fields this code knows.
 */
async function pinnedEvent(event: StripeEvent, fetcher: typeof fetch): Promise<StripeEvent> {
  if (event.type === "invoice.created") return event
  const path = OBJECT_PATHS.find(([prefix]) => event.type.startsWith(prefix))?.[1]
  const id = event.data.object.id
  if (!path || typeof id !== "string" || !OBJECT_ID.test(id))
    throw new ApiError(502, "BILLING_UPSTREAM", "Billing could not complete this request. Please retry.")
  const object = await modelPlanStripe(`${path}/${encodeURIComponent(id)}`, {}, fetcher)
  if (object.id !== id)
    throw new ApiError(502, "BILLING_UPSTREAM", "Billing could not complete this request. Please retry.")
  return { ...event, data: { ...event.data, object } }
}

/**
 * Handles one event as the webhook would (reconcile, ledger, or the renewal queued) and marks it done. On failure, a
 * durable `reconcile` is queued for its account when the account can be found, so access converges through the outbox
 * even while the event itself waits for the next run. Returns whether the event was handled.
 */
async function replayEvent(event: StripeEvent, fetcher: typeof fetch, now: number, until: number) {
  let pinned: StripeEvent | undefined
  try {
    pinned = await pinnedEvent(event, fetcher)
    await reconcileModelPlanEvent(pinned, fetcher, { now, source: "replay" })
  } catch (error) {
    const subject = await eventSubject(pinned ?? event, fetcher).catch(() => undefined)
    if (subject)
      await enqueueAction(
        "reconcile",
        subject.account,
        subject.hint ? { hint: subject.hint } : {},
        undefined,
        fetcher,
        now,
      ).catch(() => undefined)
    console.warn("Vector Codium: a Stripe event could not be replayed", { event: event.id, error: describe(error) })
    if (until - event.created >= ALERT_AFTER_S) await reportFailure(event, error, fetcher)
    return false
  }
  // Best effort: a lost marker only means the next run handles the event once more, which changes nothing.
  await persistentStore(["SET", eventDoneKey(event.id), String(now), "PX", EVENT_DONE_KEEP_MS], fetcher).catch(
    () => undefined,
  )
  return true
}

async function reportFailure(event: StripeEvent, error: unknown, fetcher: typeof fetch) {
  await notifyOwner(
    {
      kind: `replay:${event.id}`,
      subject: "Vector Codium: a Stripe event keeps failing",
      lines: [
        `Replay could not handle the Stripe event ${event.id} (${event.type}), created at ${new Date(event.created * 1000).toISOString()}.`,
        `Last error: ${describe(error)}`,
        "",
        "Replay tries it again every 10 minutes for three days, and queues a reconcile for its account when it can find the account. Check the event in Stripe's dashboard; the owner page's reconcile button runs the account again.",
      ],
      dedupeMs: ALERT_KEEP_MS,
    },
    fetcher,
  ).catch(() => undefined)
}

async function reportOverflow(since: number, until: number, fetcher: typeof fetch) {
  console.warn("Vector Codium: replay found more events than one run reads", { since, until })
  await notifyOwner(
    {
      kind: "replay-overflow",
      subject: "Vector Codium: replay could not read every Stripe event",
      lines: [
        `Between ${new Date(since * 1000).toISOString()} and ${new Date(until * 1000).toISOString()} Stripe listed more events than one replay run reads.`,
        "Replay handled the newest of them and left its cursor where it was. Older events in that window are handled only by the webhook until the window passes.",
      ],
      dedupeMs: DAY_S * 1000,
    },
    fetcher,
  ).catch(() => undefined)
}

/** An error's code or name only, for the logs and the owner: never a value from Stripe. */
function describe(error: unknown) {
  return error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown"
}

/** Whether a request carries the cron's bearer secret, compared in constant time. */
export function cronAuthorized(request: ApiRequest) {
  const supplied = Buffer.from(String(request.headers.authorization ?? ""))
  const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
  return !!process.env.CRON_SECRET && supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

/**
 * The 10-minute replay cron (contract §4.19). Like the webhook and the outbox, it is not gated on MODEL_PLANS_ENABLED:
 * freezes and endings must still reach every service. Until a Stripe key is configured it touches nothing. The answer
 * is counts only, never an account, an event or an amount.
 */
export default async function handler(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    if (!cronAuthorized(request))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the Codium replay job.")
    if (!process.env.STRIPE_SECRET_KEY?.trim()) return json(response, 200, { enabled: false })
    json(response, 200, { enabled: true, ...(await replayStripeEvents({ fetcher })) })
  } catch (error) {
    handleApiError(response, error)
  }
}
