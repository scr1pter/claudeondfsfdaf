import { createHash, randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { codiumKey } from "./codium-keys.js"
import { renewalGraceMinutes } from "./codium-limits.js"
import { ApiError } from "./http.js"
import { stripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"
import {
  MODEL_SPEND_LUA,
  modelSpendKeys,
  modelSpendStale,
  modelSpendUnavailable,
  readModelSpendLedger,
  runPoolKey,
} from "./codium-spend-ledger.js"

/*
 * A Codium account's pool: the month's model spend its OpenRouter key may make, counted in integer micro-dollars
 * (1 USD = 1,000,000). Contract §4.7 and invariants M1–M3:
 *
 * - total     = credits + carry                         (what the month holds; carry comes with an upgrade, WP A09)
 * - model     = max(key usage, committed)               (committed: the durable floor of settled model charges, A17)
 * - spent     = model + debits                          (debits: hosted blocks and other charges made off OpenRouter)
 * - limit     = credits + carry − applied debits        (the key's limit, the hard cap, M1)
 * - available = credits + carry − applied debits − model − held − abandoned   (M3)
 *
 * Provider usage can lag a finished request. The committed floor (codium-spend-ledger.ts) records every model charge
 * the gateway settled, so a lagging usage figure never reopens money; it is never used to lower the provider key's
 * limit (M1) or the provider liability funding reports. Abandoned model reservations (open past their deadline, outcome
 * unknown) keep counting at their full amount.
 *
 * A debit is written unapplied with a hold of the same amount in the pool's held set, and stays held until the key's
 * limit has been lowered by it (applied), so an unapplied debit is counted once, as held, and an applied one once, in
 * the limit. Every place that decides whether the pool can pay (the gateway's fast path, provisioning,
 * `requireMonthlyCredits`, holds for hosted and other charges, and status) works from these figures.
 *
 * This module holds the arithmetic, the store records and the scripts. The account-level operations that need the
 * account's lease and its OpenRouter key (`holdPool`, `applyPoolDebits`, `drainDebitApplies`) are in
 * model-plan-account.ts beside the provisioning they share.
 */

export const MICRO_PER_USD = 1_000_000
/** A key's limit is PATCHed in whole cents and matches what it should be when within half a cent (M1). */
export const HALF_CENT_MICRO = 5_000
/** The gateway gives a provider request 600 seconds; its hold lapses a minute after that. */
export const MODEL_HOLD_MS = 660_000
/** The longest hold a pool charge may ask for: a 12-hour cloud-computer job with room to settle. */
export const MAX_POOL_HOLD_MS = 2 * 86_400_000
/** An unapplied debit stays held this long, past the end of the month it belongs to, so it never stops counting. */
export const DEBIT_HOLD_MS = 35 * 86_400_000
/** How long after its key's period ends a key's debits are kept, for the owner's audits and the drift sweep. */
export const DEBITS_KEEP_MS = 40 * 86_400_000
/** A debit that could not be applied at once is retried after this long (outbox action `debit-apply`). */
export const DEBIT_RETRY_MS = 60_000
export const DEBIT_APPLY_ACTION = "debit-apply"

/**
 * What a hold or charge pays for: the purposes clients send with chat (`X-Vector-Purpose`, contract §4.9) and the run
 * services. It is part of every held member, so a later admission step can share the pool out by purpose.
 */
export const POOL_PURPOSES = [
  "chat",
  "title",
  "brain",
  "review",
  "judge",
  "race",
  "playbook",
  "task",
  "cloud-agents",
  "hosted",
] as const
export type PoolPurpose = (typeof POOL_PURPOSES)[number]

export function isPoolPurpose(value: unknown): value is PoolPurpose {
  return POOL_PURPOSES.some((purpose) => purpose === value)
}

// ── Amounts ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Dollars to whole micro-dollars, to the nearest one. */
export function usdToMicro(usd: number) {
  if (!Number.isFinite(usd)) throw new RangeError("A Codium amount must be a finite number of dollars.")
  return Math.round(usd * MICRO_PER_USD)
}

/** Dollars to whole micro-dollars, never fewer: a hold must cover everything the request could cost. */
export function usdToMicroCeil(usd: number) {
  if (!Number.isFinite(usd)) throw new RangeError("A Codium amount must be a finite number of dollars.")
  return Math.ceil(usd * MICRO_PER_USD - 1e-6)
}

export function microToUsd(micro: number) {
  return micro / MICRO_PER_USD
}

/** The limit an OpenRouter key is given for `micro`: whole cents, never below zero. */
export function limitUsd(micro: number) {
  return Math.round(Math.max(0, micro) / 10_000) / 100
}

/**
 * Whether a key's limit, as OpenRouter reports it in dollars, is what the pool says it should be. The limit is set in
 * whole cents, so anything within half a cent matches: 73.94 for an expected 73.936 is left alone.
 */
export function limitMatches(limit: unknown, expectedMicro: number) {
  return (
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    Math.abs(usdToMicro(limit) - Math.max(0, expectedMicro)) <= HALF_CENT_MICRO
  )
}

/** What a key's own allowance is made of. */
export type PoolBase = { creditsMicro: number; carryMicro: number }

/**
 * What the store holds against one key: live holds (nonmodel holds and model reservations before their deadline),
 * abandoned model reservations, the committed model floor, and the debits already applied to its limit or still pending.
 */
export type PoolLedger = {
  heldMicro: number
  abandonedMicro: number
  committedMicro: number
  appliedMicro: number
  pendingMicro: number
}

export const EMPTY_LEDGER: PoolLedger = Object.freeze({
  heldMicro: 0,
  abandonedMicro: 0,
  committedMicro: 0,
  appliedMicro: 0,
  pendingMicro: 0,
})

/** The key's limit: credits plus carry, less every debit already applied to it (§4.7 `expectedLimit`). */
export function expectedLimitMicro(base: PoolBase, appliedDebitsMicro: number) {
  return Math.max(0, base.creditsMicro + base.carryMicro - appliedDebitsMicro)
}

/**
 * Every figure of one pool, from the key's usage and the store's ledger. Model spend is the larger of the provider's
 * usage and the committed floor, never their sum: each settled model charge is in both once the provider catches up.
 */
export function poolFigures(base: PoolBase, usageMicro: number, ledger: PoolLedger) {
  const totalMicro = base.creditsMicro + base.carryMicro
  const modelMicro = Math.max(usageMicro, ledger.committedMicro)
  const debitsMicro = ledger.appliedMicro + ledger.pendingMicro
  return {
    totalMicro,
    spentMicro: modelMicro + debitsMicro,
    limitMicro: expectedLimitMicro(base, ledger.appliedMicro),
    /** What is left of the month, ignoring holds: what status shows as the share left. */
    remainingMicro: totalMicro - modelMicro - debitsMicro,
    /** What a new hold may take (M3), as HOLD and ADMIT compute it. A pending debit is in `heldMicro`, counted once. */
    availableMicro:
      totalMicro - ledger.appliedMicro - modelMicro - ledger.heldMicro - ledger.abandonedMicro,
  }
}

/**
 * The share of the month's pool spent, as a whole percent between 0 and 1: (usage + debits) / (credits + carry).
 * Holds are not spent, so a running request does not move it; the share left is `1 − poolShareUsed(...)`, which keeps
 * used + left at exactly 100 (H5). A pool with nothing in it reads as used up.
 */
export function poolShareUsed(figures: { totalMicro: number; spentMicro: number }) {
  if (!(figures.totalMicro > 0)) return 1
  return Math.min(100, Math.max(0, Math.round((figures.spentMicro / figures.totalMicro) * 100))) / 100
}

// ── Store records ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The pool's held set: one member per hold, scored by when it lapses. */
export const heldKey = (pool: string) => codiumKey("held", pool)
/** The debits charged against one key (ref → debit). Debits live only here, never in the account record. */
export const debitsKey = (account: string, keyHash: string) => codiumKey("debits", account, keyHash)
/** Keys with a debit still to apply, scored by when to try again: the outbox action `debit-apply` drains it. */
export const debitApplyKey = () => codiumKey(DEBIT_APPLY_ACTION)
const debitApplyMember = (account: string, keyHash: string) => `${account}:${keyHash}`

const TICKET = /^[A-Za-z0-9-]{1,64}$/
const RUN = /^[A-Za-z0-9_.-]{1,128}$/
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/
const MEMBER = /^([A-Za-z0-9-]{1,64}):([a-z][a-z0-9-]{0,31}):([A-Za-z0-9_.-]{1,128}):(\d{1,15})$/

/** A held member, `<ticket>:<purpose>:<runId or ->:<micro>` (§4.6). */
export function holdMember(ticket: string, purpose: PoolPurpose, run: string | undefined, micro: number) {
  if (!TICKET.test(ticket) || !isPoolPurpose(purpose) || !Number.isSafeInteger(micro) || micro < 0)
    throw invalidCharge()
  if (run !== undefined && (!RUN.test(run) || run === "-")) throw invalidCharge()
  return `${ticket}:${purpose}:${run ?? "-"}:${micro}`
}

export function parseHoldMember(member: string) {
  const match = MEMBER.exec(member)
  if (!match) return undefined
  return {
    ticket: match[1]!,
    purpose: match[2]!,
    run: match[3] === "-" ? undefined : match[3],
    micro: Number(match[4]),
  }
}

export function validRunId(run: string | undefined) {
  return run === undefined || (RUN.test(run) && run !== "-")
}

export function validDebitRef(ref: string) {
  return REF.test(ref)
}

// `micro` and `applied` are read by the scripts below as text ("micro":<digits>, "applied":true|false), so a debit is
// always written by JSON.stringify, which puts no space after a colon.
const Micro = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Debit = Schema.Struct({
  micro: Micro,
  applied: Schema.Boolean,
  // The held member that keeps this debit counted until it is applied.
  hold: Schema.String,
  purpose: Schema.String,
  run: Schema.optional(Schema.String),
  at: Schema.Number,
})
export type PoolDebit = typeof Debit.Type & { ref: string }

// ── Scripts ────────────────────────────────────────────────────────────────────────────────────────────────────────

// A set's lifetime only ever grows: a short hold never cuts short a longer one already in it.
const growTtl = (key: string, ms: string) =>
  `if redis.call('PTTL', ${key}) < tonumber(${ms}) then redis.call('PEXPIRE', ${key}, ${ms}) end `

/**
 * HOLD. The common hold for hosted blocks and every other pool charge (§4.7 `holdPool`). ARGV[1] is one JSON payload:
 * the member, its amount, deadline and set lifetime, an optional run, the observed provider usage, and the fence (the
 * private account record, key, period and snapshot the caller priced against). In one step it applies the same fence
 * and the same floor as model ADMIT (codium-spend-ledger.ts), so a hold observed before a key replacement, an upgrade
 * intent or a new period can never land after the source balances were read, and a lagging usage figure or an
 * abandoned model reservation can never be spent twice. Answers 'ok', 'monthly', 'stale', 'runexpired' or
 * 'unavailable'; every refusal is decided before the first write.
 */
const HOLD =
  MODEL_SPEND_LUA +
  `
local p = object(ARGV[1])
if not p or type(p.fence) ~= 'table' or not integer(p.now) or p.fence.now ~= p.now or p.fence.pool ~= p.pool or p.fence.account ~= p.account or not integer(p.required) or p.required == 0 or not integer(p.deadline) or p.deadline <= p.now or not integer(p.ttl) or p.ttl == 0 or not integer(p.observedMicro) or type(p.member) ~= 'string' or (p.run ~= nil and type(p.run) ~= 'string') then return 'unavailable' end
local parsed = member(p.member)
if not parsed or parsed.micro ~= p.required or parsed.run ~= (p.run or '-') then return 'unavailable' end
local spend = model_spend_read(KEYS[3], KEYS[4], KEYS[1], KEYS[2], p.now, p.account, p.pool)
if not spend or spend.records[parsed.ticket] then return 'unavailable' end
local refusal = model_pool_fence(KEYS[6], KEYS[7], p.fence, spend)
if refusal then return refusal end
if p.run and not model_run_pool(KEYS[5], p.pool) then return 'runexpired' end
local burden = plus(plus(plus(math.max(p.observedMicro, spend.committed), spend.reserved), spend.nonmodelHeld), spend.applied)
if not burden then return 'unavailable' end
if p.fence.totalMicro - burden < p.required then return 'monthly' end
model_spend_compact(spend, KEYS[3], KEYS[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', p.now)
local fresh = redis.call('EXISTS', KEYS[1]) == 0
redis.call('ZADD', KEYS[1], p.deadline, p.member)
if fresh then redis.call('PEXPIREAT', KEYS[1], p.now + p.ttl) else grow(KEYS[1], p.now + p.ttl, p.now) end
if p.run then model_bind_run_pool(KEYS[5], p.pool, math.max(p.now + 259200000, p.deadline), p.now) end
return 'ok'
`

/**
 * DEBIT. A pool charge's hold (ARGV[1]) becomes an unapplied debit (ref ARGV[2], record ARGV[3]) held by a member of
 * its own amount (ARGV[5], lapsing at ARGV[4]) until it is applied, and the key is queued for `debit-apply` (member
 * ARGV[8] at ARGV[9], or earlier if it already is). A ref already recorded is not recorded again (0): the held set is
 * looked at only to give back the hold this settle came with, and never the member that keeps the recorded debit
 * counted, so a settle retried while its debit is still pending cannot drop that debit's hold.
 */
const DEBIT = `local recorded = redis.call('HGET', KEYS[2], ARGV[2]) if recorded then if not string.find(recorded, '"hold":"' .. ARGV[1] .. '"', 1, true) then redis.call('ZREM', KEYS[1], ARGV[1]) end return 0 end redis.call('HSET', KEYS[2], ARGV[2], ARGV[3]) redis.call('ZREM', KEYS[1], ARGV[1]) redis.call('PEXPIREAT', KEYS[2], ARGV[7]) redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5]) ${growTtl("KEYS[1]", "ARGV[6]")}local due = redis.call('ZSCORE', KEYS[3], ARGV[8]) if not due or tonumber(due) > tonumber(ARGV[9]) then redis.call('ZADD', KEYS[3], ARGV[9], ARGV[8]) end return 1`

/**
 * APPLY. Marks the named debits (ARGV[3], ARGV[5], …) applied and drops their holds (ARGV[4], ARGV[6], …), saves the
 * account record (ARGV[1], unless empty) with the limit just set, and takes the key off the `debit-apply` queue
 * (ARGV[2]) once none is left unapplied. Returns how many are still unapplied.
 */
const APPLY = `for i = 3, #ARGV, 2 do local debit = redis.call('HGET', KEYS[1], ARGV[i]) if debit then redis.call('HSET', KEYS[1], ARGV[i], (string.gsub(debit, '"applied":false', '"applied":true', 1))) end redis.call('ZREM', KEYS[2], ARGV[i + 1]) end if ARGV[1] ~= '' then redis.call('SET', KEYS[3], ARGV[1]) end local pending = 0 for _, debit in ipairs(redis.call('HVALS', KEYS[1])) do if string.find(debit, '"applied":false', 1, true) then pending = pending + 1 end end if pending == 0 then redis.call('ZREM', KEYS[4], ARGV[2]) end return pending`

/** DEBITS. One key's debits as a flat list of ref, record, … whatever protocol the store speaks. */
const DEBITS = "return redis.call('HGETALL', KEYS[1])"

/** The scripts, for the tests and any store fake that has to recognise them. The pool's READ is the ledger's. */
export const POOL_SCRIPTS = Object.freeze({ HOLD, DEBIT, APPLY, DEBITS })

// ── Store operations ───────────────────────────────────────────────────────────────────────────────────────────────

/** One hold in a pool's held set. */
export type PoolTicket = {
  account: string
  pool: string
  ticket: string
  member: string
  purpose: PoolPurpose
  run?: string
  micro: number
}

/** The private record and pool a hold is priced against (the fence both HOLD and ADMIT compare). */
export type PoolFunding = {
  pool: string
  /** credits + carry − the provider usage observed with the record. */
  baseMicro: number
  totalMicro: number
  subscription: string
  start: number
  end: number
  accountRecord: string
}

/** What the shared Lua fence compares: the observed private record and pool, at `now` (both scripts, one shape). */
export function poolFence(
  funding: PoolFunding,
  at: { account: string; now: number; version?: number },
) {
  return {
    account: at.account,
    accountRecord: funding.accountRecord,
    pool: funding.pool,
    subscription: funding.subscription,
    start: funding.start,
    end: funding.end,
    totalMicro: funding.totalMicro,
    livemode: stripeMode() === "live",
    graceMs: renewalGraceMinutes() * 60_000,
    now: at.now,
    ...(at.version === undefined ? {} : { version: at.version }),
  }
}

/**
 * Places a hold of `requiredMicro` on the pool when what is available covers it, in the HOLD script's one step.
 * Undefined when it does not (the shortfall); throws the fence's answers: 503 RENEWING (retry) when the private record,
 * key or period moved on since `fence` was observed, 401 RUN_EXPIRED for a run bound to another pool, and 503
 * POOL_UNAVAILABLE for an untrusted ledger.
 */
export async function placeHold(
  input: {
    account: string
    funding: PoolFunding
    requiredMicro: number
    purpose: PoolPurpose
    run?: string
    ttlMs: number
    now: number
    /** The snapshot version the caller's decisions used; omitted, the fence checks the live snapshot's state only. */
    version?: number
  },
  fetcher: typeof fetch = fetch,
): Promise<PoolTicket | undefined> {
  const observedMicro = input.funding.totalMicro - input.funding.baseMicro
  if (
    !Number.isSafeInteger(input.funding.baseMicro) ||
    !Number.isSafeInteger(input.funding.totalMicro) ||
    input.funding.totalMicro < 0 ||
    !Number.isSafeInteger(observedMicro) ||
    observedMicro < 0 ||
    !Number.isSafeInteger(input.requiredMicro) ||
    input.requiredMicro <= 0 ||
    !Number.isSafeInteger(input.ttlMs) ||
    input.ttlMs <= 0 ||
    input.ttlMs > DEBIT_HOLD_MS ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0
  )
    throw invalidCharge()
  const ticket = randomUUID()
  const member = holdMember(ticket, input.purpose, input.run, input.requiredMicro)
  const held = await persistentStore(
    [
      "EVAL",
      HOLD,
      7,
      heldKey(input.funding.pool),
      debitsKey(input.account, input.funding.pool),
      modelSpendKeys(input.funding.pool).ledger,
      modelSpendKeys(input.funding.pool).reservations,
      runPoolKey(input.run ?? "-"),
      codiumKey("account", input.account),
      codiumKey("ent", input.account),
      JSON.stringify({
        now: input.now,
        account: input.account,
        pool: input.funding.pool,
        member,
        required: input.requiredMicro,
        deadline: input.now + input.ttlMs,
        ttl: input.ttlMs,
        observedMicro,
        ...(input.run === undefined ? {} : { run: input.run }),
        fence: poolFence(input.funding, { account: input.account, now: input.now, version: input.version }),
      }),
    ],
    fetcher,
  )
  if (held === "runexpired")
    throw new ApiError(401, "MODEL_PLAN_RUN_EXPIRED", "This run must start again for the new Codium period.")
  if (held === "stale") throw modelSpendStale()
  if (held === "monthly") return undefined
  if (held !== "ok") throw modelSpendUnavailable()
  return {
    account: input.account,
    pool: input.funding.pool,
    ticket,
    member,
    purpose: input.purpose,
    ...(input.run === undefined ? {} : { run: input.run }),
    micro: input.requiredMicro,
  }
}

/** Gives a hold back unspent: the request or block never reached anything that bills. */
export async function releaseHold(hold: PoolTicket, fetcher: typeof fetch = fetch) {
  await persistentStore(["ZREM", heldKey(hold.pool), hold.member], fetcher)
}

/**
 * The ticket of the held member that keeps one debit counted until it is applied: derived from the debit's ref, so it
 * is the same on every retry of that settle, differs for every other debit (two settles of one hold included), and can
 * never equal a hold's own ticket (a random UUID).
 */
export function debitHoldTicket(ref: string) {
  if (!validDebitRef(ref)) throw invalidCharge()
  return `debit-${createHash("sha256").update(ref).digest("hex").slice(0, 40)}`
}

/**
 * Records what a pool charge cost as an unapplied debit on its key, keeps it held until it is applied, and queues the
 * key for `debit-apply`. False when `ref` was already recorded, which makes a retried settle harmless: the debit keeps
 * its own held member, and only the hold the retry came with is given back.
 */
export async function recordDebit(
  hold: PoolTicket,
  charge: { ref: string; micro: number; keepUntil: number; now: number },
  fetcher: typeof fetch = fetch,
) {
  if (!validDebitRef(charge.ref) || !Number.isSafeInteger(charge.micro) || charge.micro < 0) throw invalidCharge()
  const member = holdMember(debitHoldTicket(charge.ref), hold.purpose, hold.run, charge.micro)
  const debit: typeof Debit.Type = {
    micro: charge.micro,
    applied: false,
    hold: member,
    purpose: hold.purpose,
    ...(hold.run === undefined ? {} : { run: hold.run }),
    at: charge.now,
  }
  const recorded = await persistentStore(
    [
      "EVAL",
      DEBIT,
      3,
      heldKey(hold.pool),
      debitsKey(hold.account, hold.pool),
      debitApplyKey(),
      hold.member,
      charge.ref,
      JSON.stringify(debit),
      charge.now + DEBIT_HOLD_MS,
      member,
      DEBIT_HOLD_MS,
      Math.max(charge.keepUntil, charge.now + DEBIT_HOLD_MS),
      debitApplyMember(hold.account, hold.pool),
      charge.now + DEBIT_RETRY_MS,
    ],
    fetcher,
  )
  return recorded === 1
}

/** Every debit recorded against one key. A record that cannot be read fails closed: it might lower the limit. */
export async function readDebits(
  account: string,
  keyHash: string,
  fetcher: typeof fetch = fetch,
): Promise<PoolDebit[]> {
  const result = await persistentStore(["EVAL", DEBITS, 1, debitsKey(account, keyHash)], fetcher)
  if (!Array.isArray(result) || result.length % 2 !== 0) throw ledgerUnavailable()
  return Array.from({ length: result.length / 2 }, (_, index) => {
    const ref = result[index * 2]
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Debit))(result[index * 2 + 1])
    if (typeof ref !== "string" || Option.isNone(decoded)) throw ledgerUnavailable()
    return { ...decoded.value, ref }
  })
}

/**
 * One key's ledger (codium-spend-ledger.ts READ): live holds, abandoned reservations, the committed model floor and the
 * applied and pending debits. A key without a trusted genesis, or any record that cannot be read, fails closed.
 */
export async function readPoolLedger(
  account: string,
  keyHash: string,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<PoolLedger> {
  return poolLedger(await readModelSpendLedger(account, keyHash, now, fetcher))
}

/** The pool's view of one key's spend ledger: live model reservations and live nonmodel holds are one held sum. */
export function poolLedger(ledger: Awaited<ReturnType<typeof readModelSpendLedger>>): PoolLedger {
  return {
    heldMicro: ledger.nonmodelHeldMicro + ledger.reservedMicro - ledger.abandonedMicro,
    abandonedMicro: ledger.abandonedMicro,
    committedMicro: ledger.committedMicro,
    appliedMicro: ledger.appliedMicro,
    pendingMicro: ledger.pendingMicro,
  }
}

/**
 * Marks `pending` debits applied and drops their holds, saving `accountRecord` (a store key and its JSON) with the limit
 * just set in the same step. Callers hold the account's lease and have already set the key's limit. Returns how many
 * debits are still unapplied: ones recorded after `pending` was read.
 */
export async function markDebitsApplied(
  input: {
    account: string
    keyHash: string
    accountRecord?: { key: string; json: string }
    pending: readonly Pick<PoolDebit, "ref" | "hold">[]
  },
  fetcher: typeof fetch = fetch,
) {
  const left = await persistentStore(
    [
      "EVAL",
      APPLY,
      4,
      debitsKey(input.account, input.keyHash),
      heldKey(input.keyHash),
      input.accountRecord?.key ?? debitsKey(input.account, input.keyHash),
      debitApplyKey(),
      input.accountRecord?.json ?? "",
      debitApplyMember(input.account, input.keyHash),
      ...input.pending.flatMap((debit) => [debit.ref, debit.hold]),
    ],
    fetcher,
  )
  const count = Number(left)
  if (!Number.isSafeInteger(count) || count < 0) throw ledgerUnavailable()
  return count
}

/** Keys whose `debit-apply` is due, oldest first. */
export async function dueDebitApplies(now: number, limit: number, fetcher: typeof fetch = fetch) {
  const result = await persistentStore(
    ["ZRANGEBYSCORE", debitApplyKey(), "-inf", now, "LIMIT", 0, Math.max(1, Math.floor(limit))],
    fetcher,
  )
  if (!Array.isArray(result)) throw ledgerUnavailable()
  return result.flatMap((member) => {
    const match = typeof member === "string" ? /^([^:]+):(.+)$/.exec(member) : null
    return match ? [{ account: match[1]!, keyHash: match[2]! }] : []
  })
}

/** Takes a key off the `debit-apply` queue once nothing is left to apply. */
export async function finishDebitApply(account: string, keyHash: string, fetcher: typeof fetch = fetch) {
  await persistentStore(["ZREM", debitApplyKey(), debitApplyMember(account, keyHash)], fetcher)
}

/** Tries a key's `debit-apply` again at `at`. */
export async function postponeDebitApply(account: string, keyHash: string, at: number, fetcher: typeof fetch = fetch) {
  await persistentStore(["ZADD", debitApplyKey(), "XX", at, debitApplyMember(account, keyHash)], fetcher)
}

function invalidCharge() {
  return new ApiError(500, "MODEL_PLAN_POOL_INVALID", "This Codium charge could not be held.")
}

function ledgerUnavailable() {
  return new ApiError(503, "MODEL_PLAN_POOL_UNAVAILABLE", "Your Codium usage could not be verified.")
}
