import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The store records of Release Guard and incidents (WP A48): JSON documents with a lifetime, each kept in a per-account
 * sorted index so a list and an erasure can find them, and one-time claims counted against a daily cap. Four scripts,
 * each one round trip, do every write that must be atomic. The Codium fake runs them as TypeScript
 * (test/ops-fixture.ts); test/release-guard.test.ts runs them on a real Valkey in CI.
 */

// SAVE. KEYS: the document, then optionally its index. ARGV: the value read ('' when it must not exist yet), the new
// value, its lifetime in ms, the index score, the index member, the oldest score the index keeps, the most members it
// keeps, the index's lifetime in ms. Writes nothing unless the stored value is still the one read. Answers 1 when
// written, 0 otherwise.
const SAVE = [
  "local current = redis.call('GET', KEYS[1])",
  "if (current or '') ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])",
  "if #KEYS > 1 then",
  "  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])",
  "  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', '(' .. ARGV[6])",
  "  redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -1 - tonumber(ARGV[7]))",
  "  redis.call('PEXPIRE', KEYS[2], ARGV[8])",
  "end",
  "return 1",
].join(" ")

// CLAIM. KEYS: the claim, the day's counter, then optionally an index. ARGV: the claimed value, the value written when
// the cap is reached ('' to write nothing), the cap, the claim's lifetime in ms, the counter's lifetime in ms, the index
// score, the index member, the oldest score the index keeps, the most members it keeps, the index's lifetime in ms. The
// claim is checked before the counter moves (dedupe before increment). Answers 0 for a claim that already exists, -1
// when the cap is reached, 1 when claimed and counted.
const CLAIM = [
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end",
  "local used = tonumber(redis.call('GET', KEYS[2]) or '0')",
  "local value = ARGV[1]",
  "local result = 1",
  "if used >= tonumber(ARGV[3]) then",
  "  if ARGV[2] == '' then return -1 end",
  "  value = ARGV[2]",
  "  result = -1",
  "else",
  "  redis.call('INCR', KEYS[2])",
  "  redis.call('PEXPIRE', KEYS[2], ARGV[5])",
  "end",
  "redis.call('SET', KEYS[1], value, 'PX', ARGV[4])",
  "if #KEYS > 2 then",
  "  redis.call('ZADD', KEYS[3], ARGV[6], ARGV[7])",
  "  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[8])",
  "  redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -1 - tonumber(ARGV[9]))",
  "  redis.call('PEXPIRE', KEYS[3], ARGV[10])",
  "end",
  "return result",
].join(" ")

// UNCLAIM. KEYS: the claim, the day's counter, then optionally the index. ARGV: the claimed value, the index member.
// Gives a claim back (the work it was for failed and will be tried again), only while it still holds that value.
const UNCLAIM = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "redis.call('DEL', KEYS[1])",
  "if tonumber(redis.call('GET', KEYS[2]) or '0') > 0 then redis.call('DECR', KEYS[2]) end",
  "if #KEYS > 2 then redis.call('ZREM', KEYS[3], ARGV[2]) end",
  "return 1",
].join(" ")

// AUDIT. KEYS: the log. ARGV: the score, the entry (unique), the most entries kept, the log's lifetime in ms.
const AUDIT = [
  "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])",
  "redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -1 - tonumber(ARGV[3]))",
  "redis.call('PEXPIRE', KEYS[1], ARGV[4])",
  "return 1",
].join(" ")

export const OPS_RECORD_SCRIPTS = Object.freeze({ SAVE, CLAIM, UNCLAIM, AUDIT })

export type IndexEntry = { key: string; score: number; member: string; keepMs: number; max: number }

function unreadable(): never {
  throw new ApiError(503, "OPS_RECORDS_UNAVAILABLE", "Vector's production check records could not be read.")
}

/** A stored JSON document decoded by `decode`, with the text it came from (the compare-and-set's expected value). */
export async function readRecord<T>(key: string, decode: (value: unknown) => T | undefined, fetcher: typeof fetch) {
  const raw = await persistentStore(["GET", key], fetcher)
  if (raw === null || raw === undefined) return { value: undefined, raw: "" }
  if (typeof raw !== "string") unreadable()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    unreadable()
  }
  const value = decode(parsed)
  if (value === undefined) unreadable()
  return { value, raw }
}

/** Writes `value` only while the stored text is still `expected` ('' for "must not exist"). */
export async function saveRecord(
  key: string,
  expected: string,
  value: unknown,
  keepMs: number,
  fetcher: typeof fetch,
  index?: IndexEntry,
) {
  const keys = index ? [key, index.key] : [key]
  const result = await persistentStore(
    [
      "EVAL",
      SAVE,
      String(keys.length),
      ...keys,
      expected,
      JSON.stringify(value),
      String(keepMs),
      String(index?.score ?? 0),
      index?.member ?? "",
      String(index ? index.score - index.keepMs : 0),
      String(index?.max ?? 0),
      String(index?.keepMs ?? 0),
    ],
    fetcher,
  )
  if (result !== 0 && result !== 1) unreadable()
  return result === 1
}

/**
 * Changes a document: `change` gets the current value (undefined when there is none) and answers the new one, or
 * undefined to change nothing. It runs again when another write came first, so it must be pure. Answers the value as
 * stored afterwards.
 */
export async function updateRecord<T>(
  key: string,
  decode: (value: unknown) => T | undefined,
  change: (current: T | undefined) => T | undefined,
  keepMs: number,
  fetcher: typeof fetch,
  index?: (value: T) => IndexEntry | undefined,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { value, raw } = await readRecord(key, decode, fetcher)
    const next = change(value)
    if (next === undefined) return value
    if (await saveRecord(key, raw, next, keepMs, fetcher, index?.(next))) return next
  }
  throw new ApiError(409, "OPS_BUSY", "This changed at the same time somewhere else. Try again.")
}

export type ClaimResult = "claimed" | "exists" | "limit"

/** Takes a one-time claim and counts it against the day's cap, in one step (dedupe before increment). */
export async function claimCounted(
  input: {
    key: string
    counter: string
    value: string
    /** Written instead when the cap is reached, so a repeat is a duplicate; omitted to write nothing. */
    refused?: string
    cap: number
    keepMs: number
    counterMs: number
    index?: IndexEntry
  },
  fetcher: typeof fetch,
): Promise<ClaimResult> {
  const keys = input.index ? [input.key, input.counter, input.index.key] : [input.key, input.counter]
  const result = await persistentStore(
    [
      "EVAL",
      CLAIM,
      String(keys.length),
      ...keys,
      input.value,
      input.refused ?? "",
      String(input.cap),
      String(input.keepMs),
      String(input.counterMs),
      String(input.index?.score ?? 0),
      input.index?.member ?? "",
      String(input.index ? input.index.score - input.index.keepMs : 0),
      String(input.index?.max ?? 0),
      String(input.index?.keepMs ?? 0),
    ],
    fetcher,
  )
  if (result === 1) return "claimed"
  if (result === 0) return "exists"
  if (result === -1) return "limit"
  unreadable()
}

/** Gives a claim back while it still holds the claimed value, uncounting it. */
export async function unclaimCounted(
  input: { key: string; counter: string; value: string; index?: { key: string; member: string } },
  fetcher: typeof fetch,
) {
  const keys = input.index ? [input.key, input.counter, input.index.key] : [input.key, input.counter]
  const result = await persistentStore(
    ["EVAL", UNCLAIM, String(keys.length), ...keys, input.value, input.index?.member ?? ""],
    fetcher,
  )
  if (result !== 0 && result !== 1) unreadable()
  return result === 1
}

/** Adds a member to a capped sorted set (a log, or remembered ids), scored by time. */
export async function appendCapped(
  key: string,
  member: string,
  input: { at: number; max: number; keepMs: number },
  fetcher: typeof fetch,
) {
  const result = await persistentStore(
    ["EVAL", AUDIT, "1", key, String(input.at), member, String(input.max), String(input.keepMs)],
    fetcher,
  )
  if (result !== 1) unreadable()
}

/** Appends an entry to a capped log. */
export function appendAudit(
  key: string,
  entry: Record<string, unknown>,
  input: { at: number; max: number; keepMs: number },
  fetcher: typeof fetch,
) {
  return appendCapped(key, JSON.stringify(entry), input, fetcher)
}

/** The members of an index, newest first. */
export async function indexMembers(key: string, limit: number, fetcher: typeof fetch) {
  const result = await persistentStore(["ZREVRANGE", key, "0", String(Math.max(0, limit - 1))], fetcher)
  if (!Array.isArray(result) || !result.every((member) => typeof member === "string")) unreadable()
  return result as string[]
}

/** Several stored JSON documents at once; a missing or unreadable one is undefined. */
export async function readRecords<T>(
  keys: readonly string[],
  decode: (value: unknown) => T | undefined,
  fetcher: typeof fetch,
) {
  if (!keys.length) return []
  const result = await persistentStore(["MGET", ...keys], fetcher)
  if (!Array.isArray(result) || result.length !== keys.length) unreadable()
  return result.map((raw) => {
    if (typeof raw !== "string") return undefined
    try {
      return decode(JSON.parse(raw))
    } catch {
      return undefined
    }
  })
}

/** UTC date, YYYY-MM-DD. */
export function utcDay(at: number) {
  return new Date(at).toISOString().slice(0, 10)
}

/** Milliseconds until the next 00:00 UTC. */
export function untilNextUtcDay(at: number) {
  const next = new Date(at)
  next.setUTCHours(24, 0, 0, 0)
  return next.getTime() - at
}
