import { luaKeyTypes } from "./lua.js"
import { SERVER_CAPS } from "../../../packages/schema/src/everywhere.js"
import type { CapCounts } from "../../../packages/schema/src/everywhere-policy.js"
import { capScopes, everywhereKeys } from "./keys.js"
import { runScript, storeInteger, storeUnavailable, type Store } from "./store.js"

/*
 * Server cap counters (contract 3.9, E3): per sponsor 30 jobs a day across routes and 3 live jobs, per requester 6 jobs
 * an hour, per installation 200 jobs a day. Day and hour windows are UTC calendar windows; each counter expires a
 * minute after its window ends. Live jobs are the sponsor's `jobs:<sponsor>` set, which the jobs module keeps.
 *
 * `readCounts` gives `decideRoute` the counts from before the job. `countJob` checks every cap again and counts the
 * job in one atomic step, so two jobs arriving together cannot both take the last place.
 */

export type CapSubject = {
  /** The sponsor's Vector account. */
  readonly sponsor: string
  /** The installation the request came from. */
  readonly installation: string
  /** The requester's platform user id on that installation. */
  readonly userId: string
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Counters outlive their window by a minute, so a read at the edge never sees a counter vanish early. */
const MARGIN_MS = 60_000

function digits(value: number, width: number) {
  return String(value).padStart(width, "0")
}

/** The UTC day window `d20261111` and when it ends. */
export function dayWindow(now: number) {
  const date = new Date(now)
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return {
    id: `d${digits(date.getUTCFullYear(), 4)}${digits(date.getUTCMonth() + 1, 2)}${digits(date.getUTCDate(), 2)}`,
    endsAt: start + DAY,
  }
}

/** The UTC hour window `h2026111114` and when it ends. */
export function hourWindow(now: number) {
  const day = dayWindow(now)
  const hour = new Date(now).getUTCHours()
  return { id: `h${day.id.slice(1)}${digits(hour, 2)}`, endsAt: day.endsAt - DAY + (hour + 1) * HOUR }
}

/** The counter keys for a job, with how long each should live from `now`. */
export function capKeys(subject: CapSubject, now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("A time in ms.")
  const day = dayWindow(now)
  const hour = hourWindow(now)
  return {
    sponsorToday: { key: everywhereKeys.count(capScopes.sponsor(subject.sponsor), day.id), ttlMs: day.endsAt - now + MARGIN_MS },
    requesterHour: {
      key: everywhereKeys.count(capScopes.requester(subject.installation, subject.userId), hour.id),
      ttlMs: hour.endsAt - now + MARGIN_MS,
    },
    installationToday: {
      key: everywhereKeys.count(capScopes.installation(subject.installation), day.id),
      ttlMs: day.endsAt - now + MARGIN_MS,
    },
    sponsorLive: { key: everywhereKeys.jobs(subject.sponsor) },
  }
}

function count(value: unknown) {
  if (value === null || value === undefined) return 0
  if (typeof value === "string" && !/^(?:0|[1-9][0-9]*)$/.test(value)) throw storeUnavailable()
  const number = storeInteger(value)
  if (number < 0) throw storeUnavailable()
  return number
}

/** The counts before a job, for `decideRoute`. */
export async function readCounts(store: Store, subject: CapSubject, now = Date.now()): Promise<CapCounts> {
  const keys = capKeys(subject, now)
  const [values, live] = await Promise.all([
    store(["MGET", keys.sponsorToday.key, keys.requesterHour.key, keys.installationToday.key]),
    store(["ZCARD", keys.sponsorLive.key]),
  ])
  if (!Array.isArray(values) || values.length !== 3) throw storeUnavailable()
  return {
    sponsorToday: count(values[0]),
    requesterHour: count(values[1]),
    installationToday: count(values[2]),
    sponsorLive: count(live),
  }
}

/**
 * Checks every cap and, only when all have room, counts the job in each window counter; one step. KEYS: sponsor day,
 * requester hour, installation day, the sponsor's live set. ARGV: the three window caps, the live cap, then the three
 * counters' lifetimes. Answers {admitted, sponsor day, requester hour, installation day, live}.
 */
export const COUNT_JOB_SCRIPT = luaKeyTypes(["counter", "counter", "counter", "zset"]) + [
  "local counts = {} local full = 0",
  "for i = 1, 3 do counts[i] = tonumber(redis.call('GET', KEYS[i]) or '0') if counts[i] >= tonumber(ARGV[i]) then full = 1 end end",
  "local live = redis.call('ZCARD', KEYS[4]) if live >= tonumber(ARGV[4]) then full = 1 end",
  "if full == 0 then for i = 1, 3 do counts[i] = redis.call('INCR', KEYS[i])",
  "if redis.call('PTTL', KEYS[i]) < 0 then redis.call('PEXPIRE', KEYS[i], ARGV[4 + i]) end end end",
  "return {1 - full, counts[1], counts[2], counts[3], live}",
].join(" ")

export type CountResult = {
  /** Every cap had room and the job is counted. */
  readonly admitted: boolean
  /** After counting when admitted; as found when not. */
  readonly counts: CapCounts
}

/** Counts a job that is about to be created, unless a cap is full (then it is refused `over-limit`). */
export async function countJob(store: Store, subject: CapSubject, now = Date.now()): Promise<CountResult> {
  const keys = capKeys(subject, now)
  const result = await runScript(
    store,
    COUNT_JOB_SCRIPT,
    [keys.sponsorToday.key, keys.requesterHour.key, keys.installationToday.key, keys.sponsorLive.key],
    [
      SERVER_CAPS.sponsorPerDay,
      SERVER_CAPS.requesterPerHour,
      SERVER_CAPS.installationPerDay,
      SERVER_CAPS.sponsorLive,
      keys.sponsorToday.ttlMs,
      keys.requesterHour.ttlMs,
      keys.installationToday.ttlMs,
    ],
  )
  if (!Array.isArray(result) || result.length !== 5) throw storeUnavailable()
  const admitted = count(result[0])
  if (admitted !== 0 && admitted !== 1) throw storeUnavailable()
  return {
    admitted: admitted === 1,
    counts: {
      sponsorToday: count(result[1]),
      requesterHour: count(result[2]),
      installationToday: count(result[3]),
      sponsorLive: count(result[4]),
    },
  }
}
