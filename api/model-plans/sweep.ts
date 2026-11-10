import { createHash } from "node:crypto"
import { codiumKey } from "../_lib/codium-keys.js"
import { renewalGraceMinutes } from "../_lib/codium-limits.js"
import { notifyOwner } from "../_lib/codium-owner.js"
import { configuredProvisioners, requeueBehindProvisioners } from "../_lib/codium-provision.js"
import { isStale, readSnapshot, type EntitlementSnapshot } from "../_lib/codium-snapshot.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import {
  accountForCustomer,
  auditModelPlanKey,
  listSubscriptions,
  planStanding,
  readModelPlanAccount,
  reconcileModelPlanAccount,
  type KeyAudit,
} from "../_lib/model-plan-account.js"
import { listStripe, modelPlanStripe, stripeRecord } from "../_lib/model-plan-stripe.js"
import { persistentStore } from "../_lib/persistent-store.js"
import { cronAuthorized } from "./replay.js"

export const maxDuration = 60

/*
 * The sweeps (contract §4.19, WP A08): what the webhook and replay can miss, found from the store's period-end index
 * (`idx:period-end`, every account whose snapshot is active, renewing, paused or frozen, scored by its period's end)
 * and from Stripe's own lists. Both run on CRON_SECRET, are not gated on MODEL_PLANS_ENABLED (freezes and endings must
 * still reach every service), and answer counts only.
 *
 * Hourly (`?scope=risk`):
 * - open disputes: every dispute Stripe lists from the last 120 days is compared with the account's risk record, and
 *   the account is reconciled when they disagree, so a dispute whose notification was lost still freezes it (M5), and
 *   one that closed still releases it;
 * - multiple live subscriptions for one customer are reported to the owner, by ids only;
 * - renewing and past due: every indexed account whose period is over is reconciled (renewals collected or not,
 *   payments recovered or failed, a grace that ran out), unless something reconciled it in the last 15 minutes;
 * - then, with what is left of the minute, an unfinished daily sweep is continued.
 *
 * Daily (04:23 UTC, no scope): every indexed account's OpenRouter key limit is audited and set back when it drifted,
 * with an owner alert (M1); stale snapshots and accounts past their period's end plus the renewal grace are reconciled;
 * and every provisioner behind the account's snapshot is queued again, as is every account a provisioner's dead letter
 * names. Where the walk got to is saved (`sweep:daily`) after every batch of accounts, and a walk the time budget cut
 * short (or the platform killed) is continued by the hourly sweep, so every account is visited within the day at any
 * size.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const SWEEP_BUDGET_MS = 50_000
/**
 * Walks start no new batch of accounts after this much of a run: one visit can wait 5 s for the account's lease and
 * then make several Stripe and OpenRouter calls of up to 10 s each, and a batch that is still running when the function
 * reaches `maxDuration` (60 s) is killed. Each finished batch is saved as it ends, so a kill loses one batch at most.
 */
export const SWEEP_WALK_BUDGET_MS = 35_000
/** An account reconciled this recently is left alone by the hourly sweep. */
export const SWEEP_FRESH_MS = 15 * MINUTE
/** Disputes are decided within about 75 days; this reaches every one still open. */
export const DISPUTE_LOOKBACK_S = 120 * 86_400
const CONCURRENCY = 4
const INDEX_PAGE = 100
const DISPUTE_MAX_PAGES = 10
const SUBSCRIPTION_MAX_PAGES = 20
const DAILY_STATE_KEEP_MS = 2 * DAY
const DUPLICATE_ALERT_KEEP_MS = 7 * DAY
const DRIFT_ALERT_KEEP_MS = 20 * HOUR
// Stripe's dispute statuses at the pinned version; any other counts as open, as reconcile reads them.
const WON = new Set(["won", "warning_closed"])
const LOST = new Set(["lost"])
// Subscriptions that bill or may bill again: what makes a second one a duplicate.
const LIVE_STATUSES = new Set(["active", "past_due", "trialing", "paused"])
const CHARGE_ID = /^(ch|py)_[a-zA-Z0-9]+$/
const PROVISION_ITEM = /^([a-z][a-z0-9-]{0,31}):(.+):(\d+)$/

/** The period-end index the snapshot write keeps (codium-snapshot.ts). */
export const sweepIndexKey = () => codiumKey("idx", "period-end")
/** `sweep:daily`: where an unfinished daily walk stopped, for the next hourly sweep. */
export const dailySweepKey = () => codiumKey("sweep", "daily")

const idOf = (value: unknown) =>
  typeof value === "string" ? value : stripeRecord(value) && typeof value.id === "string" ? value.id : undefined

// ── Walking the index ───────────────────────────────────────────────────────────────────────────────────────────

type Position = { score: number; member: string }

const beyond = (entry: Position, position: Position) =>
  entry.score > position.score || (entry.score === position.score && entry.member > position.member)

async function indexRange(min: string, max: string, offset: number, fetcher: typeof fetch): Promise<Position[]> {
  const result = await persistentStore(
    ["ZRANGEBYSCORE", sweepIndexKey(), min, max, "WITHSCORES", "LIMIT", offset, INDEX_PAGE],
    fetcher,
  )
  if (!Array.isArray(result)) throw unavailable()
  // The REST API answers member, score, member, score…; a client speaking RESP3 nests each pair instead.
  const flat: unknown[] = result.flatMap((value: unknown) => (Array.isArray(value) ? value : [value]))
  if (flat.length % 2 !== 0) throw unavailable()
  const entries: Position[] = []
  for (let index = 0; index < flat.length; index += 2) {
    const member = flat[index]
    const score = Number(flat[index + 1])
    if (typeof member !== "string" || !member || !Number.isFinite(score)) throw unavailable()
    entries.push({ member, score })
  }
  return entries
}

/**
 * Visits the index's accounts scored up to `max`, in score order (then by id), from just after `from`, a few at a time,
 * until `deadline`. Returns whether it reached the end and the last account it visited, from where a later walk goes on.
 */
async function walkIndex(input: {
  from?: Position
  max: string
  deadline: number
  fetcher: typeof fetch
  visit: (account: string) => Promise<void>
  /** Called after each batch with the last account it visited, so a walk the platform kills keeps its progress. */
  visited?: (position: Position) => Promise<void>
}): Promise<{ finished: boolean; position?: Position }> {
  let position = input.from
  let min = position ? String(position.score) : "-inf"
  let offset = 0
  for (;;) {
    const page = await indexRange(min, input.max, offset, input.fetcher)
    const fresh = position ? page.filter((entry) => beyond(entry, position!)) : page
    if (!fresh.length) {
      if (page.length < INDEX_PAGE) return { finished: true, ...(position ? { position } : {}) }
      // A whole page of accounts tied at the score already visited: read on past them.
      offset += page.length
      continue
    }
    for (let start = 0; start < fresh.length; start += CONCURRENCY) {
      if (Date.now() >= input.deadline) return { finished: false, ...(position ? { position } : {}) }
      const chunk = fresh.slice(start, start + CONCURRENCY)
      await Promise.all(chunk.map((entry) => input.visit(entry.member)))
      position = chunk.at(-1)!
      await input.visited?.(position)
    }
    if (page.length < INDEX_PAGE) return { finished: true, position }
    min = String(position!.score)
    offset = 0
  }
}

type Outcome = "reconciled" | "skipped" | "failed"

/** Reconciles the account (source `sweep`) when `due` says its snapshot needs it, or when it has none. */
async function reconcileIfDue(
  account: string,
  fetcher: typeof fetch,
  now: number,
  due: (snapshot: EntitlementSnapshot) => boolean,
): Promise<Outcome> {
  // A snapshot that cannot be read, or one from the other mode, is rewritten by the reconcile.
  const snapshot = await readSnapshot(account, fetcher).catch(() => undefined)
  if (snapshot && !due(snapshot)) return "skipped"
  try {
    await reconcileModelPlanAccount(account, fetcher, now, { source: "sweep" })
    return "reconciled"
  } catch (error) {
    console.warn("Vector Codium: the sweep could not reconcile an account", { account, error: describe(error) })
    return "failed"
  }
}

// ── Hourly: risk ────────────────────────────────────────────────────────────────────────────────────────────────

export type RiskSweepResult = {
  /** Accounts whose period is over: reconciled, left alone (reconciled in the last 15 minutes), or failed. */
  reconciled: number
  skipped: number
  failed: number
  disputes: { checked: number; reconciled: number; failed: number; complete: boolean }
  duplicates: { found: number; failed: number; complete: boolean }
  /** An unfinished daily walk, continued; absent when there was none or no time was left. */
  daily?: DailySweepResult
}

/** The hourly sweep (`?scope=risk`). Disputes first: they stop money. */
export async function runRiskSweep(
  options: { fetcher?: typeof fetch; now?: number; budgetMs?: number } = {},
): Promise<RiskSweepResult> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  const started = Date.now()
  const deadline = started + (options.budgetMs ?? SWEEP_BUDGET_MS)
  const walkDeadline = Math.min(deadline, started + SWEEP_WALK_BUDGET_MS)
  const disputes = await checkDisputes(fetcher, now, deadline)
  const duplicates = await checkDuplicates(fetcher, now, deadline)
  const counts = { reconciled: 0, skipped: 0, failed: 0 }
  // Renewing, paused (past due, waiting for the bank, an unpaid renewal) and active past its period: every account
  // whose period has ended.
  await walkIndex({
    max: String(now),
    deadline: walkDeadline,
    fetcher,
    visit: async (account) => {
      counts[await reconcileIfDue(account, fetcher, now, (snapshot) => now - snapshot.checkedAt >= SWEEP_FRESH_MS)]++
    },
  })
  const daily = Date.now() < walkDeadline ? await continueDailySweep(fetcher, now, walkDeadline) : undefined
  return { ...counts, disputes, duplicates, ...(daily ? { daily } : {}) }
}

/**
 * Compares each dispute Stripe lists from the last DISPUTE_LOOKBACK_S with the risk record of the account its charge
 * belongs to: a charge with a dispute still open that the record does not hold is reconciled with that charge as the
 * hint (reconcile reads it again and freezes the account), and a charge the record holds whose disputes all closed is
 * reconciled so the account is released, or ended on a loss.
 */
async function checkDisputes(fetcher: typeof fetch, now: number, deadline: number) {
  const result = { checked: 0, reconciled: 0, failed: 0, complete: true }
  let listing: Awaited<ReturnType<typeof listStripe>>
  try {
    listing = await listStripe(
      "disputes",
      [
        ["created[gte]", String(Math.floor(now / 1000) - DISPUTE_LOOKBACK_S)],
        ["expand[]", "data.charge"],
      ],
      { maxPages: DISPUTE_MAX_PAGES },
      fetcher,
    )
  } catch (error) {
    console.warn("Vector Codium: the sweep could not list disputes", { error: describe(error) })
    return { ...result, failed: 1, complete: false }
  }
  result.complete = listing.complete
  // By customer, then by charge: open while any dispute on the charge is.
  const customers = new Map<string, Map<string, boolean>>()
  for (const dispute of listing.data) {
    const charge = idOf(dispute.charge)
    if (!charge || !CHARGE_ID.test(charge)) continue
    let customer = stripeRecord(dispute.charge) ? idOf(dispute.charge.customer) : undefined
    if (!customer && Date.now() < deadline)
      customer = await modelPlanStripe(`charges/${encodeURIComponent(charge)}`, {}, fetcher).then(
        (value) => idOf(value.customer),
        () => {
          result.failed++
          return undefined
        },
      )
    if (!customer) continue
    result.checked++
    const status = String(dispute.status)
    const open = !WON.has(status) && !LOST.has(status)
    const charges = customers.get(customer) ?? new Map<string, boolean>()
    customers.set(customer, charges)
    charges.set(charge, (charges.get(charge) ?? false) || open)
  }
  for (const [customer, charges] of customers) {
    if (Date.now() >= deadline) {
      result.complete = false
      break
    }
    try {
      const account = await accountForCustomer(customer, fetcher)
      const record = account ? await readModelPlanAccount(account, fetcher) : undefined
      if (!account || !record) continue
      const held = record.risk?.openDisputes ?? {}
      const unknown = [...charges].flatMap(([charge, open]) => (open && !Object.hasOwn(held, charge) ? [charge] : []))
      const settled = [...charges].some(([charge, open]) => !open && Object.hasOwn(held, charge))
      for (const charge of unknown) {
        await reconcileModelPlanAccount(account, fetcher, now, { source: "sweep", hint: { kind: "dispute", charge } })
        result.reconciled++
      }
      if (!unknown.length && settled) {
        await reconcileModelPlanAccount(account, fetcher, now, { source: "sweep" })
        result.reconciled++
      }
    } catch (error) {
      result.failed++
      console.warn("Vector Codium: the sweep could not check a customer's disputes", { error: describe(error) })
    }
  }
  return result
}

/**
 * Finds customers with more than one live Codium subscription and reports each account that, by reconcile's own rule
 * (the governing subscription, honouring an upgrade's `vector_supersedes`), has duplicates: ids only, once a week per
 * set of duplicates. Nothing is cancelled here.
 */
async function checkDuplicates(fetcher: typeof fetch, now: number, deadline: number) {
  const result = { found: 0, failed: 0, complete: true }
  let listing: Awaited<ReturnType<typeof listStripe>>
  try {
    // Without a status filter Stripe lists every subscription that is not canceled.
    listing = await listStripe("subscriptions", [], { maxPages: SUBSCRIPTION_MAX_PAGES }, fetcher)
  } catch (error) {
    console.warn("Vector Codium: the sweep could not list subscriptions", { error: describe(error) })
    return { ...result, failed: 1, complete: false }
  }
  result.complete = listing.complete
  const customers = new Map<string, Set<string>>()
  for (const subscription of listing.data) {
    const metadata = stripeRecord(subscription.metadata) ? subscription.metadata : undefined
    const customer = idOf(subscription.customer)
    if (
      typeof subscription.id !== "string" ||
      !customer ||
      typeof metadata?.vector_account_id !== "string" ||
      !LIVE_STATUSES.has(String(subscription.status))
    )
      continue
    customers.set(customer, (customers.get(customer) ?? new Set()).add(subscription.id))
  }
  for (const [customer, subscriptions] of customers) {
    if (subscriptions.size < 2) continue
    if (Date.now() >= deadline) {
      result.complete = false
      break
    }
    try {
      const account = await accountForCustomer(customer, fetcher)
      const record = account ? await readModelPlanAccount(account, fetcher) : undefined
      if (!account || !record) continue
      const standing = planStanding(account, record, await listSubscriptions(customer, fetcher), now)
      if (!standing.duplicates.length) continue
      result.found++
      await reportDuplicates(account, standing.governing?.id, standing.duplicates, fetcher)
    } catch (error) {
      result.failed++
      console.warn("Vector Codium: the sweep could not check a customer's subscriptions", { error: describe(error) })
    }
  }
  return result
}

async function reportDuplicates(
  account: string,
  governing: string | undefined,
  duplicates: readonly string[],
  fetcher: typeof fetch,
) {
  const set = [...duplicates].sort()
  const digest = createHash("sha256").update(set.join(",")).digest("hex").slice(0, 16)
  const sent = await notifyOwner(
    {
      kind: `duplicates:${account}:${digest}`,
      subject: "Vector Codium: an account has more than one live subscription",
      lines: [
        `Account: ${account}`,
        `Governing subscription: ${governing ?? "none"}`,
        `Other live subscriptions: ${set.join(", ")}`,
        "",
        "Only the governing subscription grants Codium. Vector does not charge the others' renewals early and pauses their collection when it can; cancel and refund them in Stripe.",
      ],
      dedupeMs: DUPLICATE_ALERT_KEEP_MS,
    },
    fetcher,
  ).catch(() => "failed" as const)
  if (sent === "failed" || sent === "unconfigured")
    console.warn("Vector Codium: an account has more than one live subscription", {
      account,
      governing,
      duplicates: set,
    })
}

// ── Daily ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type DailySweepResult = {
  /** Accounts reconciled (stale or past their period's end plus the grace), left alone, or steps that failed. */
  reconciled: number
  skipped: number
  failed: number
  /** Keys whose limit (or switch) had drifted and was set back. */
  repaired: number
  /** Provisioner items queued again. */
  requeued: number
  /** Whether the walk reached the end of the index; if not, the hourly sweep continues it. */
  finished: boolean
}

const DailyState = (value: unknown): { startedAt: number; position?: Position } | undefined => {
  if (!stripeRecord(value) || typeof value.startedAt !== "number") return undefined
  const position = stripeRecord(value.position) ? value.position : undefined
  return typeof position?.score === "number" && typeof position.member === "string"
    ? { startedAt: value.startedAt, position: { score: position.score, member: position.member } }
    : { startedAt: value.startedAt }
}

async function readDailyState(fetcher: typeof fetch) {
  const stored = await persistentStore(["GET", dailySweepKey()], fetcher)
  if (typeof stored !== "string") return undefined
  try {
    return DailyState(JSON.parse(stored))
  } catch {
    return undefined
  }
}

/**
 * The daily sweep. It goes on with a walk an earlier run left unfinished; otherwise it starts a new one, first queuing
 * again the provisioners every dead letter names (an account that ended is no longer in the index).
 */
export async function runDailySweep(
  options: { fetcher?: typeof fetch; now?: number; budgetMs?: number } = {},
): Promise<DailySweepResult> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  const started = Date.now()
  const deadline = Math.min(started + (options.budgetMs ?? SWEEP_BUDGET_MS), started + SWEEP_WALK_BUDGET_MS)
  const counts = emptyDaily()
  let state = await readDailyState(fetcher)
  if (!state) {
    state = { startedAt: now }
    await persistentStore(["SET", dailySweepKey(), JSON.stringify(state), "PX", DAILY_STATE_KEEP_MS], fetcher)
    counts.requeued += await requeueDeadLetters(fetcher, now, counts)
  }
  return dailyWalk(state, fetcher, now, deadline, counts)
}

/** Goes on with an unfinished daily walk, if there is one. */
async function continueDailySweep(fetcher: typeof fetch, now: number, deadline: number) {
  const state = await readDailyState(fetcher).catch(() => undefined)
  return state ? dailyWalk(state, fetcher, now, deadline, emptyDaily()) : undefined
}

function emptyDaily(): Omit<DailySweepResult, "finished"> {
  return { reconciled: 0, skipped: 0, failed: 0, repaired: 0, requeued: 0 }
}

async function dailyWalk(
  state: { startedAt: number; position?: Position },
  fetcher: typeof fetch,
  now: number,
  deadline: number,
  counts: Omit<DailySweepResult, "finished">,
): Promise<DailySweepResult> {
  const grace = renewalGraceMinutes() * MINUTE
  const due = (snapshot: EntitlementSnapshot) =>
    isStale(snapshot, now) || (snapshot.periodEnd > 0 && now > snapshot.periodEnd + grace)
  const save = (position?: Position) =>
    persistentStore(
      [
        "SET",
        dailySweepKey(),
        JSON.stringify({ startedAt: state.startedAt, ...(position ? { position } : {}) }),
        "PX",
        DAILY_STATE_KEEP_MS,
      ],
      fetcher,
    )
  const walk = await walkIndex({
    ...(state.position ? { from: state.position } : {}),
    max: "+inf",
    deadline,
    fetcher,
    // Where the walk got to, after every batch: a run the platform kills at its time limit loses one batch at most.
    visited: async (position) => {
      await save(position)
    },
    visit: async (account) => {
      // The audit first: a reconcile would set a drifted limit back without saying so.
      try {
        const audit = await auditModelPlanKey(account, fetcher)
        if (audit.outcome === "repaired") {
          counts.repaired++
          await reportDrift(account, audit.drift, fetcher)
        }
      } catch (error) {
        counts.failed++
        console.warn("Vector Codium: the sweep could not audit a key", { account, error: describe(error) })
      }
      counts[await reconcileIfDue(account, fetcher, now, due)]++
      try {
        counts.requeued += await requeueBehindProvisioners(account, fetcher, now)
      } catch (error) {
        counts.failed++
        console.warn("Vector Codium: the sweep could not queue a provisioner", { account, error: describe(error) })
      }
    },
  })
  if (walk.finished) await persistentStore(["DEL", dailySweepKey()], fetcher)
  else await save(walk.position)
  return { ...counts, finished: walk.finished }
}

/** Queues again the provisioners of every account a provisioner's dead letter names. Returns how many it queued. */
async function requeueDeadLetters(fetcher: typeof fetch, now: number, counts: { failed: number }) {
  const dead = await persistentStore(["ZRANGE", codiumKey("outbox", "dead"), 0, -1], fetcher)
  if (!Array.isArray(dead)) throw unavailable()
  const provisioners = new Set(configuredProvisioners())
  const accounts = new Set<string>()
  for (const id of dead) {
    const match = typeof id === "string" ? PROVISION_ITEM.exec(id) : null
    if (match && provisioners.has(match[1]!)) accounts.add(match[2]!)
  }
  let requeued = 0
  for (const account of accounts)
    requeued += await requeueBehindProvisioners(account, fetcher, now).catch((error: unknown) => {
      counts.failed++
      console.warn("Vector Codium: the sweep could not queue a provisioner", { account, error: describe(error) })
      return 0
    })
  return requeued
}

const DRIFT_LINES: Record<Extract<KeyAudit, { outcome: "repaired" }>["drift"], string> = {
  above: "a spending limit above what its pool allows",
  below: "a spending limit below what its pool allows",
  unset: "no spending limit at all",
  enabled: "been switched on while the account is on hold",
}

async function reportDrift(
  account: string,
  drift: Extract<KeyAudit, { outcome: "repaired" }>["drift"],
  fetcher: typeof fetch,
) {
  console.warn("Vector Codium: an OpenRouter key had drifted and was set back", { account, drift })
  await notifyOwner(
    {
      kind: `key-drift:${account}`,
      subject: "Vector Codium: an OpenRouter key was changed outside Vector",
      lines: [
        `The OpenRouter key of account ${account} had ${DRIFT_LINES[drift]}. The daily sweep set it back to what Vector Codium allows.`,
        "",
        "Vector sets these keys only through its own API calls, so someone or something else changed this one. Check who can manage keys on the Codium OpenRouter account.",
      ],
      dedupeMs: DRIFT_ALERT_KEEP_MS,
    },
    fetcher,
  ).catch(() => undefined)
}

// ── The route ───────────────────────────────────────────────────────────────────────────────────────────────────

/** An error's code or name only, for the logs: never a value from Stripe or the store. */
function describe(error: unknown) {
  return error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown"
}

function unavailable() {
  return new ApiError(503, "CODIUM_SWEEP_UNAVAILABLE", "The Vector Codium sweep could not read the store.")
}

/**
 * `GET /api/model-plans/sweep?scope=risk` (hourly) and `GET /api/model-plans/sweep` (daily, 04:23 UTC). Until a Stripe
 * key is configured it touches nothing. The answer is counts only, never an account, a customer or an amount.
 */
export default async function handler(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    if (!cronAuthorized(request))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the Codium sweep jobs.")
    const scope = queryValue(request, "scope") ?? "daily"
    if (scope !== "risk" && scope !== "daily")
      throw new ApiError(400, "SWEEP_SCOPE_INVALID", "This sweep scope does not exist.")
    if (!process.env.STRIPE_SECRET_KEY?.trim()) return json(response, 200, { enabled: false })
    const result = scope === "risk" ? await runRiskSweep({ fetcher }) : await runDailySweep({ fetcher })
    json(response, 200, { enabled: true, scope, ...result })
  } catch (error) {
    handleApiError(response, error)
  }
}
