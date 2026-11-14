import { ENTITLEMENTS, type PlanId } from "../../packages/schema/src/codium-entitlements.js"
import { OPS_LIMITS } from "../../packages/ops-worker/src/limits.js"
import { codiumKey, codiumKeyIn } from "./codium-keys.js"
import { notifyOwner } from "./codium-owner.js"
import { readSwitch } from "./codium-switches.js"
import { ApiError } from "./http.js"
import { OPS_PLANS, readOpsRoster, rosterCounts, type RosterEntry } from "./ops-accounts.js"
import type { StripeMode } from "./model-plan-stripe.js"
import { opsCall, opsConfigured } from "./ops-worker.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The ops guard (WP A50; contract §4.19 `/api/ops/guard`, every 10 minutes): keeps the ops Worker's Cloudflare bill
 * inside a budget that grows with the subscribers it serves.
 *
 *   budget = (Max subscribers × Max's cap cost + Ultra subscribers × Ultra's cap cost) × 2 + $5
 *
 * The counts come from the ops roster (ops-accounts.ts: accounts whose plan gives the Worker work now). The cap costs are
 * the owner's estimates of what one subscriber costs at the plan's caps (contract §1.4: about $0.11 on Max and $0.90 on
 * Ultra). The $5 is a fixed allowance (the size of the Workers Paid base), so a fleet of a few subscribers is not
 * alerted over cents. The month's usage charges come from Cloudflare's GraphQL Analytics API, read with an Account
 * Analytics read-only token, for the ops Worker's script and its Durable Object namespace, priced at Cloudflare's
 * published rates without the plan's included amounts (so it errs high). The base fee itself is not in the spend: it
 * is paid whatever the guard does.
 *
 * - At 75% of the budget the owner gets one email a month.
 * - At 100% the guard holds (the Worker's `suspend`, reason `guard`) only the accounts using more than their own plan
 *   and settings can explain: monitor probes over the last day above what their monitors at their plan's interval
 *   would make, with room for release watches and a margin. Every other account keeps running, and the owner gets one
 *   email a month.
 * - Below 100% (a new month, a raised budget) every account the guard held is released.
 *
 * Without analytics (not configured, or unreadable) nothing is held, and the owner is told; Cloudflare's own budget
 * alerts (owner-actions/hosted-ops.md) are the backstop. A hold never outlives the month it was made in: holds from an
 * earlier month are released whether or not the analytics can be read. Dollar figures stay in the owner's email; the cron's
 * answer carries counts and a share only. Nothing here reads URLs, settings or anything an account wrote.
 */

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export const OPS_GUARD = {
  /** The budget's fixed allowance, in dollars (the size of Workers Paid's monthly base). */
  baseUsd: 5,
  /** The budget is this many times the subscribers' cap cost. */
  margin: 2,
  /** Owner estimates of one subscriber's ops cost at the caps, in dollars a month (contract §1.4). */
  capCostUsd: { "vector-100": 0.11, "vector-200": 0.9 } as Partial<Record<PlanId, number>>,
  /** The owner hears at this share of the budget, */
  alertShare: 0.75,
  /** and accounts above their expected usage are held from this one. */
  holdShare: 1,
  /** Usage is compared over the last day, in whole hours as the Worker keeps them (the current hour included). */
  windowMs: 25 * HOUR_MS,
  /** An account is above its expected usage past this multiple of it, */
  tolerance: 1.25,
  /** plus this many probes. */
  slackProbes: 12,
  /** An account checked within this is not read again while the budget stays exceeded. */
  recheckMs: HOUR_MS,
  /** Accounts read at once. */
  concurrency: 8,
  /** Cloudflare's published Workers Paid rates, in dollars (owner-actions/hosted-ops.md lists the source). */
  prices: {
    requestsPerMillion: 0.3,
    objectRequestsPerMillion: 0.15,
    gbSecondsPerMillion: 12.5,
    /** Durable Objects are billed at 128 MB of memory for their active time. */
    objectGb: 0.125,
  },
} as const

export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql"
const DEFAULT_SCRIPT = "vector-ops"

export const opsGuardHeldKey = (mode?: StripeMode) =>
  mode ? codiumKeyIn(mode, "ops", "guard", "held") : codiumKey("ops", "guard", "held")
export const opsGuardCheckedKey = (mode?: StripeMode) =>
  mode ? codiumKeyIn(mode, "ops", "guard", "checked") : codiumKey("ops", "guard", "checked")

function money(value: number) {
  return `$${value.toFixed(2)}`
}

function month(now: number) {
  return new Date(now).toISOString().slice(0, 7)
}

/** The month's start (UTC), which Cloudflare's monthly bill roughly follows. */
export function monthStart(now: number) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

/** One plan's cap cost: `VECTOR_OPS_GUARD_CAP_COST_<price>_USD` when it is a number from 0 to 100, else the estimate. */
export function capCost(plan: PlanId) {
  const price = plan.slice("vector-".length)
  const raw = process.env[`VECTOR_OPS_GUARD_CAP_COST_${price}_USD`]?.trim()
  const value = raw ? Number(raw) : Number.NaN
  if (Number.isFinite(value) && value >= 0 && value <= 100) return value
  return OPS_GUARD.capCostUsd[plan] ?? 0
}

/** The month's budget in dollars for these subscriber counts. */
export function opsGuardBudget(counts: Partial<Record<PlanId, number>>) {
  let variable = 0
  for (const plan of OPS_PLANS) variable += (counts[plan] ?? 0) * capCost(plan)
  return variable * OPS_GUARD.margin + OPS_GUARD.baseUsd
}

// ── Cloudflare's analytics ─────────────────────────────────────────────────────────────────────────────────────────

export type AnalyticsConfiguration = { accountId: string; token: string; script: string; namespaceId: string }

/**
 * VECTOR_OPS_CF_ACCOUNT_ID (or VECTOR_R2_ACCOUNT_ID, the same Cloudflare account), VECTOR_OPS_CF_ANALYTICS_TOKEN (an
 * API token with Account Analytics: Read only), VECTOR_OPS_CF_NAMESPACE_ID (the OpsAccount Durable Object namespace)
 * and optionally VECTOR_OPS_CF_SCRIPT (default vector-ops). Undefined while any is missing or malformed.
 */
export function analyticsConfiguration(): AnalyticsConfiguration | undefined {
  const accountId = (process.env.VECTOR_OPS_CF_ACCOUNT_ID?.trim() || process.env.VECTOR_R2_ACCOUNT_ID?.trim()) ?? ""
  const token = process.env.VECTOR_OPS_CF_ANALYTICS_TOKEN?.trim() ?? ""
  const namespaceId = process.env.VECTOR_OPS_CF_NAMESPACE_ID?.trim() ?? ""
  const script = process.env.VECTOR_OPS_CF_SCRIPT?.trim() || DEFAULT_SCRIPT
  if (!/^[0-9a-f]{32}$/.test(accountId) || !/^[0-9a-f]{32}$/.test(namespaceId)) return undefined
  if (!/^[\x21-\x7e]{20,200}$/.test(token) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(script)) return undefined
  return { accountId, token, script, namespaceId }
}

// Datasets and fields as Cloudflare documents them for Workers and Durable Objects billing metrics.
export const SPEND_QUERY = [
  "query OpsSpend($account: string!, $script: string!, $namespace: string!, $start: Time!, $end: Time!) {",
  "  viewer {",
  "    accounts(filter: { accountTag: $account }) {",
  "      workers: workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $script, datetime_geq: $start, datetime_lt: $end }) { sum { requests } }",
  "      objects: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { namespaceId: $namespace, datetimeMinute_geq: $start, datetimeMinute_lt: $end }) { sum { requests } }",
  "      periodic: durableObjectsPeriodicGroups(limit: 10000, filter: { namespaceId: $namespace, datetimeMinute_geq: $start, datetimeMinute_lt: $end }) { sum { activeTime } }",
  "    }",
  "  }",
  "}",
].join("\n")

export type OpsSpend = {
  usd: number
  requests: number
  objectRequests: number
  /** Durable Object active time, microseconds. */
  activeMicros: number
  from: number
  to: number
}

function sum(groups: unknown, field: string) {
  if (!Array.isArray(groups)) return undefined
  let total = 0
  for (const group of groups) {
    const value = (group as { sum?: Record<string, unknown> } | null)?.sum?.[field]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
    total += value
  }
  return total
}

/** The usage charges Cloudflare's published rates put on these totals, in dollars (the base fee is not usage). */
export function priceSpend(totals: { requests: number; objectRequests: number; activeMicros: number }) {
  const prices = OPS_GUARD.prices
  const gbSeconds = (totals.activeMicros / 1_000_000) * prices.objectGb
  return (
    (totals.requests / 1_000_000) * prices.requestsPerMillion +
    (totals.objectRequests / 1_000_000) * prices.objectRequestsPerMillion +
    (gbSeconds / 1_000_000) * prices.gbSecondsPerMillion
  )
}

/**
 * The ops Worker's spend this month so far, from Cloudflare's GraphQL Analytics API, or undefined when it cannot be
 * read (not configured, refused, malformed, unreachable). One request; no redirect is followed.
 */
export async function readOpsSpend(
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  configuration = analyticsConfiguration(),
): Promise<OpsSpend | undefined> {
  if (!configuration) return undefined
  const from = monthStart(now)
  let response: Response
  try {
    response = await fetcher(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${configuration.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: SPEND_QUERY,
        variables: {
          account: configuration.accountId,
          script: configuration.script,
          namespace: configuration.namespaceId,
          start: new Date(from).toISOString(),
          end: new Date(now).toISOString(),
        },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return undefined
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  const text = await response.text().catch(() => "")
  if (!text || text.length > 256 * 1024) return undefined
  let body: { data?: { viewer?: { accounts?: unknown[] } }; errors?: unknown }
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (Array.isArray(body.errors) && body.errors.length) return undefined
  const accounts = body.data?.viewer?.accounts
  if (!Array.isArray(accounts) || accounts.length !== 1) return undefined
  const account = accounts[0] as Record<string, unknown>
  const requests = sum(account.workers, "requests")
  const objectRequests = sum(account.objects, "requests")
  const activeMicros = sum(account.periodic, "activeTime")
  if (requests === undefined || objectRequests === undefined || activeMicros === undefined) return undefined
  return {
    usd: priceSpend({ requests, objectRequests, activeMicros }),
    requests,
    objectRequests,
    activeMicros,
    from,
    to: now,
  }
}

// ── One account's usage ────────────────────────────────────────────────────────────────────────────────────────────

type HourRow = { monitor: string; hour: number; ok: number; failed: number; inconclusive: number }

/** What the guard reads from the Worker's `state` answer: monitor ids, hourly probe totals and recent releases. */
export function decodeUsage(state: Record<string, unknown>) {
  const monitors = Array.isArray(state.monitors) ? state.monitors.length : undefined
  const hourly = Array.isArray(state.hourly) ? (state.hourly as HourRow[]) : undefined
  const releases = Array.isArray(state.releases) ? (state.releases as { at?: unknown; state?: unknown }[]) : undefined
  if (monitors === undefined || !hourly || !releases) return undefined
  const counts = (row: HourRow) =>
    [row?.ok, row?.failed, row?.inconclusive].every((value) => Number.isSafeInteger(value) && (value as number) >= 0)
  if (!hourly.every((row) => row && Number.isSafeInteger(row.hour) && counts(row))) return undefined
  return { monitors, hourly, releases }
}

export type Usage = { observed: number; expected: number; above: boolean }

/**
 * An account's monitor probes over the guard's window against what its own plan and settings explain: each monitor once
 * per interval (the fastest plan's interval while the account changed plan within the window), one extra round each
 * for joining, and every release watched in the window at the plan's watch length and paths. Above means past
 * `tolerance` times that, plus the slack.
 */
export function accountUsage(entry: Pick<RosterEntry, "plan" | "since">, state: Record<string, unknown>, now: number) {
  const usage = decodeUsage(state)
  if (!usage) return undefined
  const from = Math.floor(now / HOUR_MS) * HOUR_MS - (OPS_GUARD.windowMs - HOUR_MS)
  const ops = ENTITLEMENTS[entry.plan].ops
  if (!ops) return undefined
  const fastest = Math.min(...OPS_PLANS.map((plan) => ENTITLEMENTS[plan].ops!.onCall.intervalSec))
  const interval = entry.since > from ? fastest : ops.onCall.intervalSec
  const rounds = Math.ceil(OPS_GUARD.windowMs / (interval * 1000)) + 1
  const monitors = Math.min(usage.monitors, OPS_LIMITS.maxMonitors)
  const releases = usage.releases.filter(
    (release) =>
      Number.isSafeInteger(release?.at) && (release.at as number) >= from - DAY_MS && release.state !== "skipped",
  ).length
  const watchRounds = Math.ceil((ops.releaseGuard.watchMin * 60_000) / OPS_LIMITS.releaseStepMs) + 2
  const expected = monitors * rounds + releases * ops.releaseGuard.paths * watchRounds
  let observed = 0
  for (const row of usage.hourly) if (row.hour >= from) observed += row.ok + row.failed + row.inconclusive
  return {
    observed,
    expected,
    above: observed > expected * OPS_GUARD.tolerance + OPS_GUARD.slackProbes,
  } satisfies Usage
}

// ── The run ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type OpsGuardResult = {
  enabled: boolean
  /** The owner's `ops` switch is off: the Worker's kill flag already stops everything. */
  switchedOff?: boolean
  counts?: Partial<Record<PlanId, number>>
  /** The month's spend as a share of the budget, to 0.01; absent while Cloudflare's analytics cannot be read. */
  share?: number
  level?: "ok" | "alert" | "hold" | "unknown"
  checked: number
  held: number
  released: number
  failures: number
  more: boolean
}

export type OpsGuardInput = {
  fetcher?: typeof fetch
  clock?: () => number
  budgetMs: number
  /** Replaces the analytics read (tests). */
  spend?: () => Promise<OpsSpend | undefined>
}

async function members(key: string, fetcher: typeof fetch) {
  const raw = await persistentStore(["ZRANGEBYSCORE", key, "-inf", "+inf", "WITHSCORES"], fetcher)
  if (!Array.isArray(raw))
    throw new ApiError(503, "OPS_RECORDS_UNAVAILABLE", "The ops guard could not read its records.")
  const out = new Map<string, number>()
  for (let index = 0; index + 1 < raw.length; index += 2) out.set(String(raw[index]), Number(raw[index + 1]))
  return out
}

async function suspend(account: string, suspended: boolean, fetcher: typeof fetch, now: number) {
  const answer = await opsCall("suspend", { account, suspended, reason: "guard", at: now }, fetcher, now)
  if (answer.applied !== true) throw new ApiError(503, "OPS_UNAVAILABLE", "The ops Worker did not apply the hold.")
}

/** One run of the guard. Answers counts and a share only. */
export async function runOpsGuard(input: OpsGuardInput): Promise<OpsGuardResult> {
  const fetcher = input.fetcher ?? fetch
  const clock = input.clock ?? Date.now
  const started = clock()
  const result: OpsGuardResult = {
    enabled: opsConfigured(),
    checked: 0,
    held: 0,
    released: 0,
    failures: 0,
    more: false,
  }
  if (!result.enabled) return result
  if ((await readSwitch("ops", fetcher, { now: started })) !== "on") return { ...result, switchedOff: true }
  /**
   * Releases the held accounts `which` picks. An account no longer on the roster is only forgotten, so a released hold
   * never writes to an account whose data was erased.
   */
  const release = async (which: (heldAt: number) => boolean) => {
    const roster = new Set((await readOpsRoster(fetcher)).map((entry) => entry.account))
    for (const [account, heldAt] of await members(opsGuardHeldKey(), fetcher)) {
      if (!which(heldAt)) continue
      if (clock() - started > input.budgetMs) {
        result.more = true
        break
      }
      try {
        if (roster.has(account)) await suspend(account, false, fetcher, clock())
        await persistentStore(["ZREM", opsGuardHeldKey(), account], fetcher)
        result.released++
      } catch {
        result.failures++
      }
    }
  }
  const counts = await rosterCounts(fetcher)
  result.counts = counts
  const budget = opsGuardBudget(counts)
  const configuration = analyticsConfiguration()
  const spend = await (input.spend ?? (() => readOpsSpend(fetcher, started, configuration)))()
  const subscribers = OPS_PLANS.map((plan) => `${plan}: ${counts[plan] ?? 0}`).join(", ")
  if (!spend) {
    result.level = "unknown"
    await notifyOwner(
      input.spend || configuration
        ? {
            kind: `ops-guard:unreadable:${new Date(started).toISOString().slice(0, 10)}`,
            subject: "Vector ops guard: Cloudflare's analytics could not be read",
            lines: [
              "The ops guard could not read the ops Worker's spend from Cloudflare's GraphQL Analytics API, so it held and released nothing.",
              "Check VECTOR_OPS_CF_ANALYTICS_TOKEN (Account Analytics: Read), VECTOR_OPS_CF_NAMESPACE_ID and Cloudflare's status. Cloudflare's budget alerts still apply.",
              "",
              `Subscribers with production checks: ${subscribers}`,
            ],
          }
        : {
            kind: `ops-guard:unconfigured:${month(started)}`,
            subject: "Vector ops guard: Cloudflare's analytics are not set up",
            lines: [
              "Production checks are on, but the ops guard has no Cloudflare analytics to compare with its budget, so it never holds an account.",
              "Set VECTOR_OPS_CF_ANALYTICS_TOKEN and VECTOR_OPS_CF_NAMESPACE_ID (docs/vector/owner-actions/hosted-ops.md).",
            ],
            dedupeMs: 35 * DAY_MS,
          },
      fetcher,
    ).catch(() => undefined)
    // A new month starts the budget over: last month's holds end even while the spend cannot be read.
    await release((heldAt) => heldAt < monthStart(started))
    return result
  }
  const share = spend.usd / budget
  result.share = Math.round(share * 100) / 100
  result.level = share >= OPS_GUARD.holdShare ? "hold" : share >= OPS_GUARD.alertShare ? "alert" : "ok"
  const figures = [
    `Month to date (from ${new Date(spend.from).toISOString().slice(0, 10)}): ${money(spend.usd)} of a ${money(budget)} budget (${Math.round(share * 100)}%).`,
    `Worker requests: ${spend.requests}; Durable Object requests: ${spend.objectRequests}; active time: ${Math.round(spend.activeMicros / 1_000_000)} s.`,
    `Subscribers with production checks: ${subscribers}`,
    "The budget is (Max x cap cost + Ultra x cap cost) x 2 + $5; the spend is the Worker's usage charges at Cloudflare's published rates, without included amounts or the base fee.",
  ]

  if (share < OPS_GUARD.holdShare) {
    if (share >= OPS_GUARD.alertShare)
      await notifyOwner(
        {
          kind: `ops-guard:alert:${month(started)}`,
          subject: `Vector ops guard: ${Math.round(share * 100)}% of this month's budget`,
          lines: [
            "The ops Worker has used three quarters of this month's budget. Nothing is held yet; at 100% the guard holds only accounts using more than their plan explains.",
            "",
            ...figures,
          ],
          dedupeMs: 35 * DAY_MS,
        },
        fetcher,
      ).catch(() => undefined)
    // Under budget: everyone the guard held runs again.
    await release(() => true)
    return result
  }

  // Over budget: read each account's usage, least recently checked first, and hold those above their own.
  const [held, checked] = await Promise.all([
    members(opsGuardHeldKey(), fetcher),
    members(opsGuardCheckedKey(), fetcher),
  ])
  const now = clock()
  const queue = (await readOpsRoster(fetcher))
    .filter((entry) => !held.has(entry.account) && (checked.get(entry.account) ?? 0) <= now - OPS_GUARD.recheckMs)
    .sort((left, right) => (checked.get(left.account) ?? 0) - (checked.get(right.account) ?? 0))
  const work = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      if (clock() - started > input.budgetMs) {
        result.more = true
        return
      }
      try {
        const at = clock()
        const usage = accountUsage(entry, await opsCall("state", { account: entry.account }, fetcher, at), at)
        if (!usage) throw new Error("unreadable state")
        result.checked++
        await persistentStore(["ZADD", opsGuardCheckedKey(), at, entry.account], fetcher)
        if (!usage.above) continue
        await suspend(entry.account, true, fetcher, at)
        await persistentStore(["ZADD", opsGuardHeldKey(), at, entry.account], fetcher)
        result.held++
      } catch {
        result.failures++
      }
    }
  }
  await Promise.all(Array.from({ length: OPS_GUARD.concurrency }, work))
  if (queue.length) result.more = true
  await notifyOwner(
    {
      kind: `ops-guard:hold:${month(started)}`,
      subject: "Vector ops guard: this month's budget is used",
      lines: [
        "The ops Worker has used this month's budget. The guard now holds only accounts whose checks exceed what their plan and settings explain; every other account keeps running.",
        `Held so far this run: ${result.held}; held in all: ${held.size + result.held}.`,
        "Raise VECTOR_OPS_GUARD_CAP_COST_100_USD or VECTOR_OPS_GUARD_CAP_COST_200_USD if the estimates are too low, or turn the ops switch off to stop every check.",
        "",
        ...figures,
      ],
      dedupeMs: 35 * DAY_MS,
    },
    fetcher,
  ).catch(() => undefined)
  return result
}

/** Forgets an account in the guard's records, in both Stripe modes (its ops data was erased). */
export async function forgetGuardAccount(account: string, fetcher: typeof fetch = fetch) {
  for (const mode of ["live", "test"] as const) {
    await persistentStore(["ZREM", opsGuardHeldKey(mode), account], fetcher)
    await persistentStore(["ZREM", opsGuardCheckedKey(mode), account], fetcher)
  }
}
