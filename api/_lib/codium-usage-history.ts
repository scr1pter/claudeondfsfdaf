import { codiumKey } from "./codium-keys.js"
import { debitsKey } from "./codium-pool.js"
import { MODEL_SPEND_LUA } from "./codium-spend-ledger.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Usage history and the forecast (WP A32). Every Codium charge lands in its pool's `day:<pool>:<date>` bucket when it
 * settles (model-plan-admit.ts SETTLE), whoever made the request: the desktop, the CLI, a run token of an @vector run
 * while the desktop is closed. Pool debits (hosted blocks and other non-model charges) are dated by when they were
 * recorded. Each period has its own key and so its own pool, so the buckets read here are this period's only. Amounts
 * stay on the server: status sends each day as a whole-percent share of the month (P1), and the forecast as a date.
 */

const DAY_MS = 86_400_000
/**
 * A monthly period spans at most 32 UTC dates (31 days that start part-way through a date), and a renewal's grace can
 * reach one more; anything longer keeps its most recent dates.
 */
export const HISTORY_MAX_DAYS = 33
/** The forecast's straight line runs over the last 7 UTC dates, today included (never before the period started). */
export const FORECAST_WINDOW_DAYS = 7
/** With fewer days of use than this in that window, the forecast uses the period's average pace instead. */
export const FORECAST_MIN_POINTS = 3
/** No forecast in a period's first 3 days, or while under 5% of the month is used (§4.11). */
export const FORECAST_HIDDEN_MS = 3 * DAY_MS
export const FORECAST_MIN_USED = 0.05

/** One UTC date's settled spend on the pool, in integer micro-dollars. Never leaves the server. */
export type UsageDay = { day: string; micro: number }

/**
 * HISTORY. KEYS[1] is the pool's debits hash, KEYS[2..] its day buckets, one per consecutive UTC date from the date
 * that starts at ARGV[1] (ms). Answers each date's settled total (the bucket's `total`, as SETTLE writes it) plus the
 * debits recorded on that date, or -1 when a value is not what those writers leave. Read only.
 */
const HISTORY =
  MODEL_SPEND_LUA +
  `
local first = integer(ARGV[1])
if not first or not typed(KEYS[1], 'hash') then return -1 end
local totals = {}
for i = 2, #KEYS do
  if not typed(KEYS[i], 'hash') then return -1 end
  local total = integer(redis.call('HGET', KEYS[i], 'total') or '0')
  if not total then return -1 end
  totals[i - 1] = total
end
for _, raw in ipairs(redis.call('HVALS', KEYS[1])) do
  local debit = object(raw)
  if not debit then return -1 end
  local micro, at = integer(debit.micro), integer(debit.at)
  if not micro or not at then return -1 end
  local index = math.floor((at - first) / 86400000) + 1
  if at >= first and index <= #totals then
    totals[index] = plus(totals[index], micro)
    if not totals[index] then return -1 end
  end
end
return totals
`

export const USAGE_HISTORY_SCRIPTS = Object.freeze({ HISTORY })

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10)
const dayStart = (time: number) => time - (time % DAY_MS)

/** The UTC dates whose buckets hold this period's spend so far: from the period's first date through today. */
export function historyDays(periodStart: number, now: number) {
  if (!Number.isSafeInteger(periodStart) || !Number.isSafeInteger(now) || periodStart < 0 || now < periodStart)
    return []
  const last = dayStart(now)
  const count = Math.min(HISTORY_MAX_DAYS, Math.floor((last - dayStart(periodStart)) / DAY_MS) + 1)
  return Array.from({ length: count }, (_, index) => isoDay(last - (count - 1 - index) * DAY_MS))
}

/**
 * This period's settled spend by UTC date, every date from the period's first through today, in one store call.
 * Undefined when the store cannot be read or holds something its writers never leave: history is for display only, so
 * status then leaves it out (and the forecast uses the period's average pace) rather than failing.
 */
export async function readUsageHistory(
  input: { account: string; pool: string; periodStart: number; now: number },
  fetcher: typeof fetch = fetch,
): Promise<UsageDay[] | undefined> {
  const days = historyDays(input.periodStart, input.now)
  if (!days.length) return []
  const result = await persistentStore(
    [
      "EVAL",
      HISTORY,
      days.length + 1,
      debitsKey(input.account, input.pool),
      ...days.map((day) => codiumKey("day", input.pool, day)),
      Date.parse(`${days[0]}T00:00:00Z`),
    ],
    fetcher,
  ).catch(() => undefined)
  if (!Array.isArray(result) || result.length !== days.length) return undefined
  const micro = result.map(Number)
  if (!micro.every((value) => Number.isSafeInteger(value) && value >= 0)) return undefined
  return days.map((day, index) => ({ day, micro: micro[index]! }))
}

/**
 * Status's `history` (§4.11): each date of the period so far with its share of the month, rounded to a whole percent.
 * A date whose share rounds to 0 reads "<1%" on the strip, whether a little was spent or nothing. The first entry is the
 * period's first date, so a client can tell where the period starts.
 */
export function usageHistory(days: readonly UsageDay[], totalMicro: number) {
  if (!(totalMicro > 0)) return []
  return days.map((entry) => ({
    day: entry.day,
    used: Math.round(Math.min(1, Math.max(0, entry.micro / totalMicro)) * 100) / 100,
  }))
}

/**
 * The share of the month spent per millisecond over the forecast window (the last 7 UTC dates, never before the period
 * started): a straight line from the window's start to now. Undefined with fewer than 3 dates of use in the window.
 */
function recentPace(input: { periodStart: number; now: number; days: readonly UsageDay[]; totalMicro: number }) {
  if (!(input.totalMicro > 0)) return undefined
  const from = Math.max(input.periodStart, dayStart(input.now) - (FORECAST_WINDOW_DAYS - 1) * DAY_MS)
  const first = isoDay(from)
  const today = isoDay(input.now)
  const points = input.days.filter((entry) => entry.micro > 0 && entry.day >= first && entry.day <= today)
  if (points.length < FORECAST_MIN_POINTS) return undefined
  const spent = points.reduce((sum, entry) => sum + entry.micro, 0) / input.totalMicro
  const span = input.now - from
  return span > 0 && spent > 0 ? spent / span : undefined
}

/**
 * The day this month's usage runs out at its current pace, as an ISO date: the straight line over the last 7 days when
 * that window has at least 3 days of use, otherwise the period's average pace so far. `used` is the share of the month
 * spent (status's figure, exact). Hidden in the first 3 days, under 5% used, once used up, and when the month lasts to
 * its end.
 */
export function forecastDate(input: {
  used: number
  periodStart: number
  periodEnd: number
  now: number
  days?: readonly UsageDay[]
  totalMicro?: number
}) {
  const elapsed = input.now - input.periodStart
  if (elapsed < FORECAST_HIDDEN_MS || !(input.used >= FORECAST_MIN_USED) || input.used >= 1) return undefined
  const pace =
    input.days && input.totalMicro !== undefined
      ? recentPace({ periodStart: input.periodStart, now: input.now, days: input.days, totalMicro: input.totalMicro })
      : undefined
  // The period average is kept in its own form, so a month that lasts exactly to its end stays hidden.
  const runsOut = pace === undefined ? input.periodStart + elapsed / input.used : input.now + (1 - input.used) / pace
  return runsOut < input.periodEnd ? isoDay(runsOut) : undefined
}
