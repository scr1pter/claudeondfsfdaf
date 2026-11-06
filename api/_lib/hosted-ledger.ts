import { createHmac } from "node:crypto"
import { Option, Schema } from "effect"
import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { Hosted } from "../../packages/schema/src/hosted.js"
import { codiumKey } from "./codium-keys.js"
import {
  DEBITS_KEEP_MS,
  debitHoldTicket,
  holdMember,
  lowerDebit,
  microToUsd,
  poolFigures,
  readPoolLedger,
  recordDebit,
  releaseHold,
  usdToMicro,
  type PoolTicket,
} from "./codium-pool.js"
import { readSnapshot } from "./codium-snapshot.js"
import { readModelSpendDay } from "./codium-spend-ledger.js"
import { readSwitch } from "./codium-switches.js"
import {
  hostedAccess,
  hostedCaps,
  hostedMinutesCap,
  hostedMinutesExpireAt,
  hostedMinutesKey,
  hostedOpen,
  hostedSnapshot,
  hoursUsed,
  unavailable,
} from "./hosted-entitlement.js"
import {
  BLOCK_HOLD_TTL_MS,
  BLOCK_MINUTES,
  HOLD_MINUTES,
  blockHoldMicro,
  chargeMinuteMicro,
  costMinuteMicro,
  egressCharge,
  hostedRatesProblems,
  storageCharge,
  trueUpMicro,
  wholeMinutes,
} from "./hosted-rates.js"
import { ApiError } from "./http.js"
import {
  applyPoolDebits,
  holdPool,
  openRouterManagement,
  readModelPlanAccount,
  withCodiumLease,
} from "./model-plan-account.js"
import { stripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The cloud computer's ledger (contract WP A51, invariant M8): every minute a computer Vector hosts runs is held in the
 * subscriber's pool before it runs and charged into it at no less than the provider's worst-case cost.
 *
 * Blocks. A session runs in blocks of `BLOCK_MINUTES` (15). Before a block starts, its hold is placed with the pool's
 * common `holdPool` (M2: the same held set, fence and available figure as model requests, M3), covering
 * `HOLD_MINUTES` (20) at the charged rate: the block itself plus the 5 minutes a session may still run to wrap up when
 * the next block cannot be held (§4.4). No block starts without its hold. A block also reserves its weighted minutes of
 * the plan's hours and, for a session's first block, a computer, atomically (OPEN), so parallel computers can never
 * pass either cap together. The running block of each session lives in `hosted:running:<account>` (§4.6).
 *
 * Settling. A block that ends (renewed by the next block, closed, or lapsed with its hold) moves to the account's
 * settle queue in the same step, and is settled from there, retried until done: its minutes rounded up to the minute,
 * at the charged rate. The hold covers up to 20 minutes; minutes beyond it (a reaper that ran late) are charged too, as
 * an overrun, so nothing a computer ran goes uncharged. The charge goes to the period active when it settles, with the
 * time it ran (`occurred_at`) on the ledger line: normally the hold's own period, whose hold then becomes its debit;
 * after a renewal or an upgrade replaced that period's key, the account's current key takes the charge and the old
 * hold is given back, because a replaced key no longer spends anything and its debits would recover nothing. The
 * minutes count in the same period's hours.
 *
 * Other charges. Snapshot storage and egress are charged nightly (WP A53 measures them), and an ended plan's disk
 * retention is charged once, at the end, to the final period, shortened to what that period can still cover. They
 * accrue before anything could hold them, so they are charged as debits of their own; each is a few cents a day.
 *
 * True-up. Once the provider's actual cost of a charge is known (the nightly job), the charge can be lowered to that
 * cost plus the markup, never below the cost itself, and never raised: the pool's debit is lowered in place and the
 * key's limit rises by the difference (M1).
 *
 * Lines. Every charge is written to `public.vector_hosted` (docs/vector/owner-actions/sql/hosted.sql): the pseudonymous
 * financial ledger. An account appears there only as an HMAC of its id under `VECTOR_HOSTED_ACCOUNT_SALT`, and lines
 * are never deleted with the account (P5's exception for pseudonymous ledger lines).
 *
 * Producers' obligations (codium-a17-admission-notes.md): a block holds its worst case and settles at most its hold on
 * the hold (anything beyond is an overrun debit on the current key); its hold lapses 30 minutes after it is placed,
 * well inside the carry true-up's retry window; it carries no run id, so the run ceiling and the run's pool binding are
 * about model requests only (a session's model requests carry their run through ADMIT); compute never counts against
 * the Brain share; and the daily share is checked before each hold (see `openBlock`). Only `MODEL_PLAN_RENEWING` from
 * `holdPool` is worth retrying.
 */

const DAY_MS = 86_400_000
const SESSION = /^[A-Za-z0-9_-]{1,64}$/
const COMPUTER = /^[A-Za-z0-9_-]{1,64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
/** A settle that failed is tried again this long after. */
export const SETTLE_RETRY_MS = 60_000

// ── Configuration ──────────────────────────────────────────────────────────────────────────────────────────────────

function supabase() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? ""
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""
  const origin = URL.parse(url)
  const local =
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL_ENV !== "production" &&
    origin?.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  if (
    !key ||
    !origin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !local)
  )
    return undefined
  return { url, key }
}

function salt() {
  const value = process.env.VECTOR_HOSTED_ACCOUNT_SALT?.trim() ?? ""
  return value.length >= 32 ? value : undefined
}

/**
 * Whether the ledger can record charges: Supabase's service role and the account salt, with valid rate settings. A
 * block never opens without it, so no minute runs that the ledger could not write down.
 */
export function hostedLedgerConfigured() {
  return supabase() !== undefined && salt() !== undefined && hostedRatesProblems().length === 0
}

/**
 * The name the hosted ledger knows an account by: HMAC-SHA-256 of its id under `VECTOR_HOSTED_ACCOUNT_SALT`, as hex.
 * The salt must never change once lines are written. WP A52 names sandboxes from the same value.
 */
export function hostedAccount(account: string) {
  const key = salt()
  if (!key) throw unavailable()
  return createHmac("sha256", key).update(`vector-hosted-account-v1:${account}`).digest("hex")
}

// ── Store keys ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Each session's running block (session → block entry), §4.6 `hosted:running:<id>`. */
export const hostedRunningKey = (account: string) => codiumKey("hosted", "running", account)
/** Blocks that ended and are not settled yet (block ref → entry). */
export const hostedSettleKey = (account: string) => codiumKey("hosted", "settle", account)
/** Accounts with blocks to settle, scored by when to try. */
export const hostedSettleDueKey = () => codiumKey("hosted", "settle-due")
/** Accounts with running blocks, scored by their earliest block's hold lapse (the reaper's lapse sweep). */
export const hostedLapseKey = () => codiumKey("hosted", "lapse")

const BlockEntry = Schema.Struct({
  v: Schema.Literal(1),
  session: Schema.String,
  block: Schema.Int,
  ref: Schema.String,
  size: Schema.Literals(Hosted.SIZES),
  startedAt: Schema.Number,
  /** Wall minutes this block reserved of the plan's hours (at most BLOCK_MINUTES). */
  minutes: Schema.Int,
  weight: Schema.Int,
  /** The meter epoch the block opened in, where its reservation lives. */
  epoch: Schema.String,
  /** The end of the period its hold was priced against, in ms. */
  periodEnd: Schema.Number,
  pool: Schema.String,
  ticket: Schema.String,
  micro: Schema.Int,
  expiresAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  /** Set once the pool has taken the charge: where it went, so a retried settle never charges twice. */
  charged: Schema.optional(
    Schema.Struct({
      pool: Schema.NullOr(Schema.String),
      epoch: Schema.String,
      periodStart: Schema.NullOr(Schema.Number),
      periodEnd: Schema.NullOr(Schema.Number),
    }),
  ),
})
export type BlockEntry = typeof BlockEntry.Type

function decodeEntry(raw: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(BlockEntry))(raw))
}

// ── Scripts ────────────────────────────────────────────────────────────────────────────────────────────────────────

// Shared by the scripts below. A key's lifetime only grows (a key without one gets it). `purge` moves running blocks
// whose hold lapsed to the settle queue, charged for their whole hold since nothing closed them (nil when an entry
// cannot be read). `rescore` keeps the account in the lapse index at its earliest running block's lapse.
const PRELUDE = `local function grow(key, at, now) local ttl = redis.call('PTTL', key) if ttl == -1 or ttl < at - now then redis.call('PEXPIREAT', key, at) end end
local function due(key, member, at) local current = redis.call('ZSCORE', key, member) if not current or tonumber(current) > at then redis.call('ZADD', key, at, member) end end
local function park(settle, e, ended) e.endedAt = ended redis.call('HSET', settle, e.ref, cjson.encode(e)) end
local function purge(running, settle, now, holdMs)
  local moved = 0
  local all = redis.call('HGETALL', running)
  for i = 1, #all, 2 do
    local ok, e = pcall(cjson.decode, all[i + 1])
    if not ok or type(e) ~= 'table' or type(e.expiresAt) ~= 'number' or type(e.startedAt) ~= 'number' or type(e.ref) ~= 'string' then return nil end
    if e.expiresAt <= now then redis.call('HDEL', running, all[i]) park(settle, e, math.min(e.expiresAt, e.startedAt + holdMs)) moved = moved + 1 end
  end
  return moved
end
local function rescore(running, index, account)
  local earliest = nil
  local all = redis.call('HGETALL', running)
  for i = 1, #all, 2 do local e = cjson.decode(all[i + 1]) if not earliest or e.expiresAt < earliest then earliest = e.expiresAt end end
  if earliest then redis.call('ZADD', index, earliest, account) else redis.call('ZREM', index, account) end
end
`

/**
 * OPEN. A block opens for a session (ARGV[1], one JSON payload). Lapsed running blocks move to the settle queue first.
 * A first block (`prev` -1) needs the session not running and fewer running than `computers`; a renewal needs the
 * session's running block to be `prev`. Then it reserves up to `want` wall minutes of what is left of `cap` weighted
 * minutes (each minute counts `weight`) and stores the entry. A renewal's previous block moves to the settle queue, its
 * reservation replaced by the minutes it actually ran. Keys: running, the period's minutes, the settle queue, the settle
 * index, the lapse index. Answers {'ok', granted minutes} or {'exists' | 'busy' | 'moved' | 'hours' | 'unavailable'};
 * a refusal changes nothing but the lapsed blocks it moved.
 */
const OPEN =
  PRELUDE +
  `local p = cjson.decode(ARGV[1]) local now = p.now
local moved = purge(KEYS[1], KEYS[3], now, p.holdMs)
if not moved then return {'unavailable'} end
if moved > 0 then grow(KEYS[3], p.settleAt, now) due(KEYS[4], p.account, now) rescore(KEYS[1], KEYS[5], p.account) end
local raw = redis.call('HGET', KEYS[1], p.session)
local current = nil
if raw then current = cjson.decode(raw) end
if p.prev < 0 then
  if current then return {'exists'} end
  if redis.call('HLEN', KEYS[1]) >= p.computers then return {'busy'} end
elseif not current or current.block ~= p.prev then return {'moved'} end
local used = tonumber(redis.call('HGET', KEYS[2], 'used') or '0')
if not used then return {'unavailable'} end
local reserved = 0
local fields = redis.call('HGETALL', KEYS[2])
for i = 1, #fields, 2 do
  if string.sub(fields[i], 1, 2) == 'r:' then
    local minutes, lapses = string.match(fields[i + 1], '^(%d+):(%d+)$')
    if not minutes then return {'unavailable'} end
    if tonumber(lapses) <= now then redis.call('HDEL', KEYS[2], fields[i])
    elseif not current or fields[i] ~= 'r:' .. current.ref then reserved = reserved + tonumber(minutes) end
  end
end
local ran = 0
if current then ran = math.max(0, math.ceil((now - current.startedAt) / 60000)) * current.weight end
local grant = math.min(p.want, math.floor((p.cap - used - reserved - ran) / p.weight))
if grant < 1 then return {'hours'} end
local e = p.entry
e.minutes = grant
redis.call('HSET', KEYS[2], 'r:' .. e.ref, string.format('%d:%d', grant * p.weight, e.expiresAt))
if current then redis.call('HSET', KEYS[2], 'r:' .. current.ref, string.format('%d:%d', ran, current.expiresAt)) end
grow(KEYS[2], p.minutesAt, now)
redis.call('HSET', KEYS[1], p.session, cjson.encode(e))
grow(KEYS[1], p.runningAt, now)
if current then park(KEYS[3], current, now) grow(KEYS[3], p.settleAt, now) due(KEYS[4], p.account, now) end
rescore(KEYS[1], KEYS[5], p.account)
return {'ok', grant}`

/**
 * CLOSE. The session's running block (ARGV[1]), if it is block ARGV[2], ends at ARGV[3] (never before it started) and
 * moves to the settle queue; the account (ARGV[5]) is due at ARGV[4]. Keys: running, the settle queue, the settle
 * index, the lapse index. Answers the moved entry, or '' when the session runs another block or none.
 */
const CLOSE =
  PRELUDE +
  `local raw = redis.call('HGET', KEYS[1], ARGV[1]) if not raw then return '' end
local e = cjson.decode(raw) if e.block ~= tonumber(ARGV[2]) then return '' end
redis.call('HDEL', KEYS[1], ARGV[1])
park(KEYS[2], e, math.max(e.startedAt, tonumber(ARGV[3])))
grow(KEYS[2], tonumber(ARGV[6]), tonumber(ARGV[4]))
due(KEYS[3], ARGV[5], tonumber(ARGV[4]))
rescore(KEYS[1], KEYS[4], ARGV[5])
return redis.call('HGET', KEYS[2], e.ref)`

/**
 * LAPSE. The reaper's sweep for one account (ARGV[2]) at ARGV[1]: running blocks whose hold lapsed (a session that
 * crashed, or a reaper that never closed it) move to the settle queue, charged for their whole hold (ARGV[3] ms), so no
 * computer time goes uncharged when nothing closes its block. Keys as CLOSE. Answers how many moved.
 */
const LAPSE =
  PRELUDE +
  `local now = tonumber(ARGV[1])
local moved = purge(KEYS[1], KEYS[2], now, tonumber(ARGV[3]))
if not moved then return -1 end
if moved > 0 then grow(KEYS[2], tonumber(ARGV[4]), now) due(KEYS[3], ARGV[2], now) end
rescore(KEYS[1], KEYS[4], ARGV[2])
return moved`

/**
 * METER. A settled block's weighted minutes (ARGV[2]) count once in the period it settled in (KEYS[2]): its
 * reservation is dropped from the period it opened in (KEYS[1]) and from this one (a renewal in the new period moved it
 * there), and `d:<ref>` keeps a retry from counting it again. 1 when counted, 0 when it already was.
 */
const METER =
  PRELUDE +
  `redis.call('HDEL', KEYS[1], 'r:' .. ARGV[1])
redis.call('HDEL', KEYS[2], 'r:' .. ARGV[1])
if redis.call('HGET', KEYS[2], 'd:' .. ARGV[1]) then return 0 end
redis.call('HINCRBY', KEYS[2], 'used', ARGV[2])
redis.call('HSET', KEYS[2], 'd:' .. ARGV[1], ARGV[2])
grow(KEYS[2], tonumber(ARGV[3]), tonumber(ARGV[4]))
return 1`

/** MARK. Records on a queued entry (ARGV[1]) where its charge went (ARGV[2], the whole entry), if it is still queued. */
const MARK = `if not redis.call('HGET', KEYS[1], ARGV[1]) then return 0 end redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) return 1`

/** FINISH. A settled entry (ARGV[1]) leaves the queue; an account (ARGV[2]) with nothing left is no longer due. */
const FINISH = `redis.call('HDEL', KEYS[1], ARGV[1]) if redis.call('HLEN', KEYS[1]) == 0 then redis.call('ZREM', KEYS[2], ARGV[2]) end return 1`

export const HOSTED_LEDGER_SCRIPTS = Object.freeze({ OPEN, CLOSE, LAPSE, METER, MARK, FINISH })

// ── Blocks ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LedgerOptions = {
  fetcher?: typeof fetch
  /** A test seam for the clock: it must return the current time on every call, as `holdPool`'s does. */
  clock?: () => number
}

export type HostedBlock = {
  session: string
  block: number
  ref: string
  size: Hosted.Size
  startedAt: number
  /** When this block's minutes are up: renew it (`openBlock` with `renew`) or close it by then. */
  endsAt: number
  /** The latest the session may run on this block's hold, if the next block cannot be held. */
  stopBy: number
}

/** The ledger ref of a session's block: `hb-<session>-<block>`. */
export function blockRef(session: string, block: number) {
  return `hb-${session}-${block}`
}

/**
 * Opens a session's block: its first (`renew` undefined) or the next after block `renew`. Checks the plan from the
 * snapshot (§4.4: a first block only while the plan is active, a renewal while it is active or renewing within the
 * grace, neither while the `hosted` switch says otherwise), the size and the daily share; holds `HOLD_MINUTES` at the
 * charged rate with `holdPool`; then, in one step, reserves the block's minutes of the plan's hours and, for a first
 * block, one of the plan's computers. Anything refused after the hold gives the hold back. A renewal's previous block is
 * settled right after (or by `drainHostedSettles` if that fails).
 */
export async function openBlock(
  account: string,
  input: { session: string; size: Hosted.Size; renew?: number },
  options: LedgerOptions = {},
): Promise<HostedBlock> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (!SESSION.test(input.session) || !Hosted.isSize(input.size))
    throw new ApiError(400, "HOSTED_REQUEST", "This cloud computer request is not valid.")
  if (input.renew !== undefined && (!Number.isSafeInteger(input.renew) || input.renew < 0))
    throw new ApiError(400, "HOSTED_REQUEST", "This cloud computer request is not valid.")
  if (!hostedLedgerConfigured()) throw unavailable()
  const first = input.renew === undefined
  const block = first ? 0 : input.renew! + 1
  const service = await readSwitch("hosted", fetcher, { now: clock() })
  if (first && !(await hostedOpen(account, fetcher)))
    throw new ApiError(503, "HOSTED_UNAVAILABLE", "The cloud computer is not available on Vector yet.")
  const snapshot = await hostedSnapshot(account, fetcher, clock())
  const access = hostedAccess(snapshot, service === "off" ? "stop" : service, clock())
  if (access !== "start" && (first || access !== "continue")) {
    if (service !== "on" && (service !== "no-new" || first)) throw unavailable()
    throw new ApiError(503, "MODEL_PLAN_RENEWING", "Your Vector Codium plan is renewing. Try again in a moment.", {
      retryAfterSeconds: 30,
    })
  }
  const caps = hostedCaps(snapshot, clock())!
  if (!caps.sizes.includes(input.size))
    throw new ApiError(403, "HOSTED_NOT_INCLUDED", "This computer size is not included in your plan.", {
      detail: { perk: "computer", limit: "size", plan: "vector-200" },
    })
  const holdMicro = blockHoldMicro(input.size)
  await requireDailyRoom(account, snapshot, holdMicro, fetcher, clock())
  const hold = await holdPool(account, microToUsd(holdMicro), BLOCK_HOLD_TTL_MS, "hosted", {
    fetcher,
    snapshot,
    ...(options.clock ? { clock: options.clock } : {}),
  })
  const startedAt = clock()
  const ref = blockRef(input.session, block)
  const weight = Hosted.SIZE_WEIGHT[input.size]
  const entry = {
    v: 1,
    session: input.session,
    block,
    ref,
    size: input.size,
    startedAt,
    minutes: 0,
    weight,
    epoch: snapshot.meterEpoch,
    periodEnd: snapshot.periodEnd,
    pool: hold.pool,
    ticket: hold.ticket,
    micro: hold.micro,
    expiresAt: hold.expiresAt,
  } satisfies BlockEntry
  const opened = await persistentStore(
    [
      "EVAL",
      OPEN,
      5,
      hostedRunningKey(account),
      hostedMinutesKey(account, snapshot.meterEpoch),
      hostedSettleKey(account),
      hostedSettleDueKey(),
      hostedLapseKey(),
      JSON.stringify({
        now: startedAt,
        account,
        session: input.session,
        prev: first ? -1 : input.renew,
        computers: caps.computers,
        cap: hostedMinutesCap(snapshot, startedAt),
        want: BLOCK_MINUTES,
        weight,
        holdMs: HOLD_MINUTES * 60_000,
        entry,
        runningAt: hold.expiresAt + DAY_MS,
        minutesAt: hostedMinutesExpireAt(snapshot.periodEnd),
        settleAt: startedAt + 40 * DAY_MS,
      }),
    ],
    fetcher,
  ).catch(async (error: unknown) => {
    await hold.release().catch(() => undefined)
    throw error
  })
  const [status, granted] = Array.isArray(opened) ? opened : []
  if (status !== "ok" || !Number.isSafeInteger(Number(granted)) || Number(granted) < 1) {
    await hold.release().catch(() => undefined)
    throw openRefusal(String(status))
  }
  if (!first) await settlePending(account, options).catch(() => undefined)
  return {
    session: input.session,
    block,
    ref,
    size: input.size,
    startedAt,
    endsAt: startedAt + Number(granted) * 60_000,
    stopBy: startedAt + HOLD_MINUTES * 60_000,
  }
}

/**
 * Ends a session's running block `block` at `endedAt` (the moment the computer stopped; now when omitted) and settles
 * it. Nothing happens when the session runs another block or none.
 */
export async function closeBlock(
  account: string,
  input: { session: string; block: number; endedAt?: number },
  options: LedgerOptions = {},
) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (!SESSION.test(input.session) || !Number.isSafeInteger(input.block) || input.block < 0)
    throw new ApiError(400, "HOSTED_REQUEST", "This cloud computer request is not valid.")
  const now = clock()
  const moved = await persistentStore(
    [
      "EVAL",
      CLOSE,
      4,
      hostedRunningKey(account),
      hostedSettleKey(account),
      hostedSettleDueKey(),
      hostedLapseKey(),
      input.session,
      input.block,
      Math.min(input.endedAt ?? now, now),
      now,
      account,
      now + 40 * DAY_MS,
    ],
    fetcher,
  )
  if (typeof moved !== "string" || moved === "") return false
  await settlePending(account, options).catch(() => undefined)
  return true
}

/** The account's running blocks, by session (for the reaper and the drift check, WP A53). */
export async function runningBlocks(account: string, fetcher: typeof fetch = fetch) {
  const flat = await persistentStore(["HGETALL", hostedRunningKey(account)], fetcher)
  return entries(flat)
}

/** Settles every block of `account` that ended and is not settled yet. Returns how many were settled. */
export async function settlePending(account: string, options: LedgerOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const queued = entries(await persistentStore(["HGETALL", hostedSettleKey(account)], fetcher))
  let settled = 0
  for (const entry of queued) {
    await settleEntry(account, entry, options)
    settled++
  }
  return settled
}

/**
 * The reaper's ledger pass (WP A53 runs it every minute), within `budgetMs`: first every running block whose hold
 * lapsed moves to its account's settle queue (`LAPSE`), then the accounts whose blocks are due are settled. An account
 * that fails is tried again after `SETTLE_RETRY_MS`; its holds and debits keep counting meanwhile.
 */
export async function drainHostedSettles(options: LedgerOptions & { budgetMs?: number; limit?: number } = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const started = clock()
  const lapsed = await persistentStore(
    ["ZRANGEBYSCORE", hostedLapseKey(), "-inf", started, "LIMIT", 0, Math.max(1, options.limit ?? 50)],
    fetcher,
  )
  for (const account of Array.isArray(lapsed) ? lapsed : []) {
    if (typeof account !== "string") continue
    const now = clock()
    await persistentStore(
      [
        "EVAL",
        LAPSE,
        4,
        hostedRunningKey(account),
        hostedSettleKey(account),
        hostedSettleDueKey(),
        hostedLapseKey(),
        now,
        account,
        HOLD_MINUTES * 60_000,
        now + 40 * DAY_MS,
      ],
      fetcher,
    )
  }
  const due = await persistentStore(
    ["ZRANGEBYSCORE", hostedSettleDueKey(), "-inf", started, "LIMIT", 0, Math.max(1, options.limit ?? 50)],
    fetcher,
  )
  const outcome = { settled: 0, retried: 0 }
  for (const account of Array.isArray(due) ? due : []) {
    if (typeof account !== "string" || clock() - started >= (options.budgetMs ?? 20_000)) break
    const settled = await settlePending(account, options).catch(() => undefined)
    if (settled === undefined) {
      await persistentStore(["ZADD", hostedSettleDueKey(), "XX", clock() + SETTLE_RETRY_MS, account], fetcher)
      outcome.retried++
    } else outcome.settled += settled
  }
  return outcome
}

async function settleEntry(account: string, entry: BlockEntry, options: LedgerOptions) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const ended = entry.endedAt ?? clock()
  const minutes = wholeMinutes(ended - entry.startedAt)
  // The hold pays for up to HOLD_MINUTES; anything the computer ran past it is an overrun, charged all the same.
  const heldMinutes = Math.min(minutes, Math.floor(entry.micro / chargeMinuteMicro(entry.size)))
  const overMinutes = minutes - heldMinutes
  const heldMicro = heldMinutes * chargeMinuteMicro(entry.size)
  const overMicro = overMinutes * chargeMinuteMicro(entry.size)
  const ticket: PoolTicket = {
    account,
    pool: entry.pool,
    ticket: entry.ticket,
    member: holdMember(entry.ticket, "hosted", undefined, entry.micro),
    purpose: "hosted",
    micro: entry.micro,
  }
  let charged = entry.charged
  if (!charged) {
    charged = await withCodiumLease(
      account,
      async (verify) => {
        const record = await readModelPlanAccount(account, fetcher)
        const key = record?.key
        if (!record || record.closing || !key) {
          // Nothing to charge (the account is being deleted): the line still records what ran.
          await releaseHold(ticket, fetcher)
          return { pool: null, epoch: entry.epoch, periodStart: null, periodEnd: null }
        }
        await verify()
        const now = clock()
        if (key.hash === entry.pool) {
          // The hold's own period is still the account's: the hold becomes the debit.
          if (heldMicro > 0)
            await recordDebit(
              ticket,
              { ref: entry.ref, micro: heldMicro, keepUntil: entry.periodEnd + DEBITS_KEEP_MS, now },
              fetcher,
            )
          else await releaseHold(ticket, fetcher)
        } else {
          // A renewal or an upgrade replaced it: the period active now pays, and the old hold goes back.
          if (heldMicro > 0) await recordOwnDebit(account, key, entry.ref, heldMicro, now, fetcher)
          await releaseHold(ticket, fetcher)
        }
        if (overMicro > 0) await recordOwnDebit(account, key, `${entry.ref}-over`, overMicro, now, fetcher)
        return {
          pool: key.hash,
          epoch: `${key.subscription}:${key.start * 1000}`,
          periodStart: key.start * 1000,
          periodEnd: key.end * 1000,
        }
      },
      fetcher,
    )
    await persistentStore(
      ["EVAL", MARK, 1, hostedSettleKey(account), entry.ref, JSON.stringify({ ...entry, charged })],
      fetcher,
    )
  }
  if (charged.pool) await applyPoolDebits(account, charged.pool, fetcher).catch(() => undefined)
  await persistentStore(
    [
      "EVAL",
      METER,
      2,
      hostedMinutesKey(account, entry.epoch),
      hostedMinutesKey(account, charged.epoch),
      entry.ref,
      minutes * entry.weight,
      hostedMinutesExpireAt(charged.periodEnd ?? entry.periodEnd),
      clock(),
    ],
    fetcher,
  )
  const period = { periodStart: charged.periodStart, periodEnd: charged.periodEnd }
  await recordLine(
    account,
    {
      ref: entry.ref,
      kind: "block",
      size: entry.size,
      units: heldMinutes,
      chargedMicro: heldMicro,
      costMicro: heldMinutes * costMinuteMicro(entry.size),
      occurredAt: entry.startedAt,
      ...period,
    },
    options,
  )
  if (overMinutes > 0)
    await recordLine(
      account,
      {
        ref: `${entry.ref}-over`,
        kind: "overrun",
        size: entry.size,
        units: overMinutes,
        chargedMicro: overMicro,
        costMicro: overMinutes * costMinuteMicro(entry.size),
        occurredAt: entry.startedAt + heldMinutes * 60_000,
        ...period,
      },
      options,
    )
  await persistentStore(
    ["EVAL", FINISH, 2, hostedSettleKey(account), hostedSettleDueKey(), entry.ref, account],
    fetcher,
  )
}

/**
 * Records a charge that has no hold of its own as a debit on `key`, held by its own member until it is applied (as the
 * carry true-up's shortfall debits are). Callers hold the account's lease and apply the pool's debits afterwards.
 */
async function recordOwnDebit(
  account: string,
  key: { hash: string; end: number },
  ref: string,
  micro: number,
  now: number,
  fetcher: typeof fetch,
) {
  const ticket = debitHoldTicket(ref)
  const member = holdMember(ticket, "hosted", undefined, micro)
  await recordDebit(
    { account, pool: key.hash, ticket, member, purpose: "hosted", micro },
    { ref, micro, keepUntil: key.end * 1000 + DEBITS_KEEP_MS, now },
    fetcher,
  )
}

/**
 * The daily share (§4.1) before a block is held: today's spend on the pool, as status counts it, plus the block's hold
 * must stay within the plan's share of the month. This check is not in the same step as the hold (the common HOLD
 * enforces the month only), so a model request admitted in between can pass it by at most one block; ADMIT itself
 * counts every live hold today, so model requests never pass the share because of a block.
 */
async function requireDailyRoom(
  account: string,
  snapshot: EntitlementSnapshot,
  holdMicro: number,
  fetcher: typeof fetch,
  now: number,
) {
  const share = snapshot.caps.dailyShare
  if (share === null) return
  const key = (await readModelPlanAccount(account, fetcher))?.key
  // A key that is not this period's yet is refused by the hold's own fence instead.
  if (!key || key.subscription !== snapshot.subscription || key.start * 1000 !== snapshot.periodStart) return
  if (key.creditsMicro === undefined) return
  const total = key.creditsMicro + (key.carry?.micro ?? 0)
  const today = await readModelSpendDay(account, key.hash, now, fetcher)
  if (today + holdMicro > Math.floor(total * share))
    throw new ApiError(429, "MODEL_PLAN_DAILY_LIMIT", "Your Codium daily limit has been reached. Try again tomorrow.", {
      retryAfterSeconds: Math.ceil((DAY_MS - (now % DAY_MS)) / 1000),
    })
}

function openRefusal(status: string) {
  if (status === "busy")
    return new ApiError(429, "HOSTED_BUSY", "All the cloud computers your plan includes are running. Stop one first.")
  if (status === "hours") return hoursUsed()
  if (status === "exists")
    return new ApiError(409, "HOSTED_SESSION_RUNNING", "This cloud computer session is already running.")
  if (status === "moved")
    return new ApiError(409, "HOSTED_SESSION_MOVED", "This cloud computer session is no longer on that block.")
  return unavailable()
}

function entries(flat: unknown) {
  if (!Array.isArray(flat) || flat.length % 2 !== 0) throw unavailable()
  const found: BlockEntry[] = []
  for (let index = 1; index < flat.length; index += 2) {
    const entry = decodeEntry(flat[index])
    if (!entry) throw unavailable()
    found.push(entry)
  }
  return found
}

/**
 * Account deletion's part of the ledger (P5, for WP A57, after the hosted provisioner has stopped the account's
 * computers): every running block is closed now and every queued block settled, so its pseudonymous line is written
 * (a closing account's pool is not charged), then the account's running blocks, settle queue and hours are deleted
 * from the store. Ledger lines are kept: they are the financial record and name the account only by its HMAC. A settle
 * that cannot finish leaves the store as it is and throws, so the deletion's cleanup tries again.
 */
export async function eraseAccountHostedLedger(account: string, options: LedgerOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  for (const entry of await runningBlocks(account, fetcher))
    await closeBlock(account, { session: entry.session, block: entry.block }, options)
  await settlePending(account, options)
  const meters: string[] = []
  let cursor = "0"
  do {
    const page = await persistentStore(
      ["SCAN", cursor, "MATCH", `${hostedMinutesKey(account, "x").slice(0, -1)}*`, "COUNT", 200],
      fetcher,
    )
    if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1])) throw unavailable()
    cursor = String(page[0])
    meters.push(...page[1].filter((key): key is string => typeof key === "string"))
  } while (cursor !== "0")
  await persistentStore(["DEL", hostedRunningKey(account), hostedSettleKey(account), ...meters], fetcher)
  await persistentStore(["ZREM", hostedSettleDueKey(), account], fetcher)
  await persistentStore(["ZREM", hostedLapseKey(), account], fetcher)
}

// ── Charges outside blocks ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * One computer's day of snapshot storage and egress (WP A53's nightly job measures both): each is charged to the
 * period active now at its rate, once per computer and UTC day. An ended plan's storage is not charged here: its
 * retention was paid for once, at the end (`chargeRetention`). Nothing is charged while the account is being deleted.
 */
export async function chargeNightly(
  account: string,
  input: { computer: string; day: string; storageGbDays: number; egressGb: number },
  options: LedgerOptions = {},
) {
  const fetcher = options.fetcher ?? fetch
  if (
    !COMPUTER.test(input.computer) ||
    !DAY.test(input.day) ||
    !Number.isFinite(Date.parse(`${input.day}T00:00:00Z`)) ||
    !Number.isFinite(input.storageGbDays) ||
    input.storageGbDays < 0 ||
    !Number.isFinite(input.egressGb) ||
    input.egressGb < 0
  )
    throw new ApiError(400, "HOSTED_REQUEST", "This cloud computer charge is not valid.")
  const snapshot = await readSnapshot(account, fetcher)
  const occurredAt = Date.parse(`${input.day}T00:00:00Z`)
  const lines: HostedLine[] = []
  if (snapshot?.state !== "ended" && input.storageGbDays > 0) {
    const storage = storageCharge(input.storageGbDays)
    lines.push(
      await chargeOnce(
        account,
        {
          ref: `hs-${input.computer}-${input.day}`,
          kind: "storage",
          units: input.storageGbDays,
          ...storage,
          occurredAt,
        },
        options,
      ),
    )
  }
  if (input.egressGb > 0) {
    const egress = egressCharge(input.egressGb)
    lines.push(
      await chargeOnce(
        account,
        { ref: `he-${input.computer}-${input.day}`, kind: "egress", units: input.egressGb, ...egress, occurredAt },
        options,
      ),
    )
  }
  return lines
}

/**
 * The disk retention after a plan ends (§4.4: kept for download, then deleted), paid once from the final period: the
 * account's last key, whatever its state. `days` are granted while that period can still cover them, at the storage
 * rate for `gb`; fewer when it cannot. Returns the days granted and when the disk must be deleted. Charged once per
 * computer and period: asking again answers the first grant.
 */
export async function chargeRetention(
  account: string,
  input: { computer: string; gb: number; days: number },
  options: LedgerOptions = {},
) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (
    !COMPUTER.test(input.computer) ||
    !Number.isFinite(input.gb) ||
    input.gb < 0 ||
    !Number.isSafeInteger(input.days) ||
    input.days < 0
  )
    throw new ApiError(400, "HOSTED_REQUEST", "This cloud computer charge is not valid.")
  const record = await readModelPlanAccount(account, fetcher)
  const key = record?.key
  const now = clock()
  if (!record || record.closing || !key) return { days: 0, until: now }
  const ref = `hr-${input.computer}-${key.subscription}-${key.start}`
  const existing = await readLine(account, ref, options)
  if (existing) return { days: existing.units, until: existing.occurredAt + existing.units * DAY_MS }
  const perDay = storageCharge(input.gb).chargedMicro
  let days = input.days
  if (perDay > 0) {
    const available = await finalPoolAvailable(account, key, now, fetcher)
    days = Math.max(0, Math.min(input.days, Math.floor(available / perDay)))
  }
  const charge = storageCharge(input.gb * days)
  const line = await chargeOnce(account, { ref, kind: "retention", units: days, ...charge, occurredAt: now }, options)
  return { days: line.units, until: line.occurredAt + line.units * DAY_MS }
}

/** What the account's final period could still pay: credits and carry less its model spend, debits and live holds. */
async function finalPoolAvailable(
  account: string,
  key: { hash: string; creditsMicro?: number; carry?: { micro: number } },
  now: number,
  fetcher: typeof fetch,
) {
  if (key.creditsMicro === undefined) return 0
  const data = (await openRouterManagement(`/${encodeURIComponent(key.hash)}`, undefined, fetcher)).data as
    | Record<string, unknown>
    | undefined
  const usage =
    typeof data?.usage === "number" && Number.isFinite(data.usage) && data.usage >= 0 ? data.usage : undefined
  if (usage === undefined) throw unavailable()
  const ledger = await readPoolLedger(account, key.hash, now, fetcher)
  return Math.max(
    0,
    poolFigures({ creditsMicro: key.creditsMicro, carryMicro: key.carry?.micro ?? 0 }, usdToMicro(usage), ledger)
      .availableMicro,
  )
}

/**
 * Charges one line to the period active now, once: a ref already on the ledger is answered as it is, so a retried
 * nightly job charges nothing twice.
 */
async function chargeOnce(account: string, line: Omit<NewLine, "periodStart" | "periodEnd">, options: LedgerOptions) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const existing = await readLine(account, line.ref, options)
  if (existing) return existing
  const period = await withCodiumLease(
    account,
    async (verify) => {
      const record = await readModelPlanAccount(account, fetcher)
      const key = record?.key
      if (!record || record.closing || !key) return undefined
      await verify()
      if (line.chargedMicro > 0) await recordOwnDebit(account, key, line.ref, line.chargedMicro, clock(), fetcher)
      return { pool: key.hash, periodStart: key.start * 1000, periodEnd: key.end * 1000 }
    },
    fetcher,
  )
  if (period && line.chargedMicro > 0) await applyPoolDebits(account, period.pool, fetcher).catch(() => undefined)
  return recordLine(
    account,
    { ...line, periodStart: period?.periodStart ?? null, periodEnd: period?.periodEnd ?? null },
    options,
  )
}

// ── True-up ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lowers one charge once the provider's actual cost of it is known (M8): to that cost plus the markup, never below the
 * cost, and never higher than it is now. Only a charge on the account's current period can be lowered: a replaced
 * key spends nothing more, so a lower debit there would return nothing. The pool's debit is lowered in place, the key's
 * limit rises by the difference, and the line keeps both figures.
 */
export async function trueUpCharge(
  account: string,
  input: { ref: string; actualCostMicro: number },
  options: LedgerOptions = {},
) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const line = await readLine(account, input.ref, options)
  if (!line) return { lowered: false as const, reason: "unknown" as const }
  const current = line.truedMicro ?? line.chargedMicro
  const target = Math.min(current, trueUpMicro(line.chargedMicro, input.actualCostMicro))
  if (target >= current) return { lowered: false as const, reason: "at-cost" as const, micro: current }
  const key = (await readModelPlanAccount(account, fetcher))?.key
  if (!key || line.periodStart !== key.start * 1000) return { lowered: false as const, reason: "period" as const }
  const result = await lowerDebit({ account, keyHash: key.hash, ref: line.ref, micro: target, now: clock() }, fetcher)
  if (result === "missing") return { lowered: false as const, reason: "period" as const }
  await applyPoolDebits(account, key.hash, fetcher).catch(() => undefined)
  const trued = await ledgerRpc(
    { action: "trued", account: hostedAccount(account), ref: line.ref, trued: target },
    options,
  )
  return { lowered: true as const, micro: decodeLine(trued.line)?.truedMicro ?? target }
}

// ── Ledger lines ───────────────────────────────────────────────────────────────────────────────────────────────────

export const LINE_KINDS = ["block", "overrun", "storage", "egress", "retention"] as const
export type LineKind = (typeof LINE_KINDS)[number]

type NewLine = {
  ref: string
  kind: LineKind
  size?: Hosted.Size
  /** Minutes (block, overrun), GB-days (storage), GB (egress) or days (retention). */
  units: number
  chargedMicro: number
  /** The provider's worst-case cost of the same units at the pinned rates: what the charge never goes below. */
  costMicro: number
  occurredAt: number
  periodStart: number | null
  periodEnd: number | null
}

const Line = Schema.Struct({
  ref: Schema.String,
  kind: Schema.Literals(LINE_KINDS),
  size: Schema.NullOr(Schema.Literals(Hosted.SIZES)),
  units: Schema.Number,
  chargedMicro: Schema.Number,
  costMicro: Schema.Number,
  truedMicro: Schema.NullOr(Schema.Number),
  periodStart: Schema.NullOr(Schema.Number),
  periodEnd: Schema.NullOr(Schema.Number),
  occurredAt: Schema.Number,
  settledAt: Schema.Number,
})
export type HostedLine = typeof Line.Type

function decodeLine(raw: unknown) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(Line)(raw))
}

/** Writes a line once; a ref already written is answered as it is. */
async function recordLine(account: string, line: NewLine, options: LedgerOptions): Promise<HostedLine> {
  const answer = await ledgerRpc(
    {
      action: "record",
      account: hostedAccount(account),
      line: { ...line, size: line.size ?? null },
    },
    options,
  )
  const stored = decodeLine(answer.line)
  if (answer.status !== "ok" || !stored) throw unavailable()
  return stored
}

/** One line of the account's ledger, or undefined. */
export async function readLine(account: string, ref: string, options: LedgerOptions = {}) {
  const answer = await ledgerRpc({ action: "get", account: hostedAccount(account), ref }, options)
  if (answer.status === "not_found") return undefined
  const line = decodeLine(answer.line)
  if (answer.status !== "ok" || !line) throw unavailable()
  return line
}

/**
 * What one period charged the account for its cloud computers, from the ledger (WP A53's drift check compares it with
 * what the computers' lifecycles should have cost): total charged and trued micro-dollars, block and overrun minutes,
 * and lines. Never shown to anyone but the owner (P1).
 */
export async function periodCharges(account: string, periodStart: number, options: LedgerOptions = {}) {
  const answer = await ledgerRpc({ action: "period", account: hostedAccount(account), periodStart }, options)
  const totals = answer.totals as Record<string, unknown> | undefined
  const numbers = ["chargedMicro", "truedMicro", "minutes", "lines"].map((field) => Number(totals?.[field]))
  if (answer.status !== "ok" || numbers.some((value) => !Number.isSafeInteger(value) || value < 0)) throw unavailable()
  const [chargedMicro, truedMicro, minutes, lines] = numbers as [number, number, number, number]
  return { chargedMicro, truedMicro, minutes, lines }
}

type Answer = Record<string, unknown> & { status: string }
const ANSWER_LIMIT = 1_000_000

/** One call to `vector_hosted`. A store that cannot be reached, or answers what it never should, is a 503. */
async function ledgerRpc(request: Record<string, unknown>, options: LedgerOptions): Promise<Answer> {
  const target = supabase()
  if (!target) throw unavailable()
  const fetcher = options.fetcher ?? fetch
  const response = await fetcher(`${target.url}/rest/v1/rpc/vector_hosted`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", apikey: target.key, authorization: `Bearer ${target.key}` },
    body: JSON.stringify({
      request: { mode: stripeMode(), now: Math.trunc((options.clock ?? Date.now)()), ...request },
    }),
  }).catch(() => undefined)
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined)
    throw unavailable()
  }
  const text = await response.text().catch(() => "")
  if (text.length > ANSWER_LIMIT) throw unavailable()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw unavailable()
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable()
  const answer = parsed as Record<string, unknown>
  if (typeof answer.status !== "string" || answer.status === "invalid") throw unavailable()
  return answer as Answer
}
