import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { codiumKey } from "./codium-keys.js"
import {
  holdMember,
  isPoolPurpose,
  MODEL_HOLD_MS,
  POOL_PURPOSES,
  poolFence,
  validRunId,
  type PoolFunding,
  type PoolPurpose,
} from "./codium-pool.js"
import { enqueueAction, registerAction } from "./codium-provision.js"
import {
  MODEL_SPEND_LUA,
  modelSpendKeys,
  modelSpendStale,
  modelSpendUnavailable,
  monthlyShortfall,
  runPoolKey,
} from "./codium-spend-ledger.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

export type AdmissionTicket = {
  account: string
  pool: string
  ticket: string
  member: string
  purpose: PoolPurpose
  run?: string
  micro: number
  day: string
  epoch: string
  version: number
  deadline: number
  periodEnd: number
  admittedAt: number
  runUntil: number
}

export type ModelPlanAdmission = {
  snapshot: EntitlementSnapshot
  funding: PoolFunding
  requiredMicro: number
  purpose: PoolPurpose
  run?: { id: string; deadline: number; ceilingShare?: number }
  globalLimit?: number
  priorityReserve?: number
}

export async function admitModelPlan(
  input: ModelPlanAdmission,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<AdmissionTicket> {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > 8_640_000_000_000_000 - 3 * 86_400_000 ||
    !Number.isSafeInteger(input.funding.baseMicro) ||
    !safeAmount(input.funding.totalMicro) ||
    !safeAmount(input.funding.totalMicro - input.funding.baseMicro) ||
    !safeAmount(input.requiredMicro) ||
    input.requiredMicro === 0 ||
    !Number.isSafeInteger(input.funding.start) ||
    input.funding.start < 0 ||
    !Number.isSafeInteger(input.funding.end) ||
    input.funding.end <= input.funding.start ||
    !safeAmount(input.funding.start * 1000) ||
    !safeAmount(input.funding.end * 1000 + 40 * 86_400_000) ||
    !isPoolPurpose(input.purpose) ||
    (input.globalLimit !== undefined && (!safeAmount(input.globalLimit) || input.globalLimit === 0)) ||
    (input.priorityReserve !== undefined && !share(input.priorityReserve))
  )
    throw modelSpendUnavailable()
  if (
    input.run &&
    (!validRunId(input.run.id) ||
      !Number.isSafeInteger(input.run.deadline) ||
      input.run.deadline <= now ||
      input.run.deadline > now + 3 * 86_400_000 ||
      (input.run.ceilingShare !== undefined && (!share(input.run.ceilingShare) || input.run.ceilingShare === 0)))
  )
    throw new ApiError(
      401,
      "MODEL_PLAN_RUN_EXPIRED",
      "This run is no longer authorized. Save your work and start a new run.",
    )
  const ticket = randomUUID()
  const admission: AdmissionTicket = {
    account: input.snapshot.account,
    pool: input.funding.pool,
    ticket,
    member: holdMember(ticket, input.purpose, input.run?.id, input.requiredMicro),
    purpose: input.purpose,
    ...(input.run ? { run: input.run.id } : {}),
    micro: input.requiredMicro,
    day: new Date(now).toISOString().slice(0, 10),
    epoch: input.snapshot.meterEpoch,
    version: input.snapshot.version,
    deadline: now + MODEL_HOLD_MS,
    periodEnd: input.funding.end * 1000,
    admittedAt: now,
    runUntil: now + 3 * 86_400_000,
  }
  const result = await persistentStore(
    [
      "EVAL",
      ADMISSION_SCRIPTS.ADMIT,
      12,
      ...admissionKeys(admission),
      JSON.stringify({
        ...admission,
        observedMicro: input.funding.totalMicro - input.funding.baseMicro,
        fence: poolFence(input.funding, {
          account: input.snapshot.account,
          now,
          version: input.snapshot.version,
        }),
        runShare: input.run?.ceilingShare,
        runDeadline: input.run?.deadline,
        globalLimit: input.globalLimit,
        priorityReserve: input.priorityReserve ?? 0,
      }),
    ],
    fetcher,
  ).catch(async (error: unknown) => {
    // The store may have run this admission and lost only its answer. Its caller dispatches nothing without a ticket,
    // so the outcome is known: nothing to charge. It is cancelled at once, which frees its slot and reservation when
    // the EVAL already ran ('ok'); SETTLE answers 'missing' when it has not run yet. Otherwise a cancellation is queued
    // for a margin past the deadline (the store call itself gives up after 3 s), so an EVAL delayed on its way cannot
    // land behind it; until then a late one counts in full. An EVAL delayed even longer would land as an abandoned
    // reservation, and so would one whose cancel and queue writes both fail: either only ever counts in full until the
    // period's ledger expires (logged with ids), never free money.
    const cancelled = await settleModelPlan(admission, { kind: "cancel" }, fetcher, now).catch(() => undefined)
    if (cancelled !== "ok")
      await queueSettlement(admission, { kind: "cancel" }, admission.deadline + LOST_ADMISSION_CANCEL_MS, fetcher)
    throw error
  })
  if (result === "ok") return admission
  if (result === "monthly") throw monthlyShortfall()
  if (result === "stale") throw modelSpendStale()
  if (typeof result === "string" && result in REFUSALS) {
    const refusal = REFUSALS[result as keyof typeof REFUSALS]
    throw new ApiError(refusal.status, refusal.code, refusal.message, {
      ...(result === "daily" ? { retryAfterSeconds: Math.ceil((86_400_000 - (now % 86_400_000)) / 1000) } : {}),
      ...(result === "run" ? { detail: { limit: "ceiling" } } : {}),
    })
  }
  throw modelSpendUnavailable()
}

export async function settleModelPlan(
  ticket: AdmissionTicket,
  outcome: { kind: "cancel" | "complete" | "broken"; chargeMicro?: number },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !safeAmount(now + 30_000) ||
    !["cancel", "complete", "broken"].includes(outcome.kind) ||
    (outcome.chargeMicro !== undefined && !safeAmount(outcome.chargeMicro))
  )
    throw modelSpendUnavailable()
  const charge = outcome.kind === "cancel" ? 0 : (outcome.chargeMicro ?? ticket.micro)
  if (outcome.kind === "broken" && charge > ticket.micro) throw modelSpendUnavailable()
  const result = await persistentStore(
    ["EVAL", ADMISSION_SCRIPTS.SETTLE, 12, ...admissionKeys(ticket), JSON.stringify(ticket), outcome.kind, charge, now],
    fetcher,
  )
  if (result !== "ok" && result !== "done" && result !== "missing") throw modelSpendUnavailable()
  return result
}

/**
 * Settles with one retry, and when both answers are lost queues the same known outcome for the outbox (`model-settle`)
 * instead of leaving it to expire. Until it lands the reservation keeps counting at its full amount, as an abandoned
 * one does past its deadline: never free money. SETTLE is idempotent ('done' or 'missing' once recorded), so a late or
 * repeated retry never charges or releases twice. True when the settlement is recorded now.
 */
export async function settleModelPlanDurably(
  ticket: AdmissionTicket,
  outcome: { kind: "cancel" | "complete" | "broken"; chargeMicro?: number },
  fetcher: typeof fetch = fetch,
) {
  const settled = await settleModelPlan(ticket, outcome, fetcher)
    .catch(() => settleModelPlan(ticket, outcome, fetcher))
    .then(
      () => true,
      () => false,
    )
  if (settled) return true
  await queueSettlement(ticket, outcome, undefined, fetcher)
  return false
}

/** An admission whose answer was lost is cancelled this long after its deadline (see `admitModelPlan`). */
export const LOST_ADMISSION_CANCEL_MS = 60_000

/** Queues a known outcome for the outbox (`model-settle`) at `at` (now when undefined), logged with ids only. */
function queueSettlement(
  ticket: AdmissionTicket,
  outcome: { kind: "cancel" | "complete" | "broken"; chargeMicro?: number },
  at: number | undefined,
  fetcher: typeof fetch,
) {
  const ids = { account: ticket.account, pool: ticket.pool, ticket: ticket.ticket, outcome: outcome.kind }
  return enqueueAction("model-settle", ticket.ticket, { ticket, outcome }, at, fetcher).then(
    () => console.warn("Vector Codium: a model settlement was queued for retry", ids),
    () => console.error("Vector Codium: a model settlement could not be recorded or queued", ids),
  )
}

const SettleRetry = Schema.Struct({
  ticket: Schema.Struct({
    account: Schema.String,
    pool: Schema.String,
    ticket: Schema.String,
    member: Schema.String,
    purpose: Schema.Literals(POOL_PURPOSES),
    run: Schema.optional(Schema.String),
    micro: Schema.Number,
    day: Schema.String,
    epoch: Schema.String,
    version: Schema.Number,
    deadline: Schema.Number,
    periodEnd: Schema.Number,
    admittedAt: Schema.Number,
    runUntil: Schema.Number,
  }),
  outcome: Schema.Struct({
    kind: Schema.Literals(["cancel", "complete", "broken"]),
    chargeMicro: Schema.optional(Schema.Number),
  }),
})

// The SETTLE script compares every ticket field with the stored reservation, so a queued payload settles only the
// reservation it names. A failure is retried with backoff, then dead-lettered with an owner alert.
registerAction("model-settle", async (action, fetcher) => {
  const retry = Option.getOrUndefined(Schema.decodeUnknownOption(SettleRetry)(action.payload))
  if (!retry) throw modelSpendUnavailable()
  await settleModelPlan(retry.ticket, retry.outcome, fetcher, action.now)
})

const admissionKeys = (ticket: AdmissionTicket) => [
  codiumKey("account", ticket.account),
  codiumKey("ent", ticket.account),
  codiumKey("held", ticket.pool),
  codiumKey("debits", ticket.account, ticket.pool),
  modelSpendKeys(ticket.pool).ledger,
  modelSpendKeys(ticket.pool).reservations,
  codiumKey("inflight", ticket.account),
  codiumKey("inflight", "global"),
  codiumKey("day", ticket.pool, ticket.day),
  codiumKey("purpose", ticket.pool),
  codiumKey("run", ticket.run ?? `no-run-${ticket.account}`),
  runPoolKey(ticket.run ?? `no-run-${ticket.account}`),
]

const safeAmount = (value: number) => Number.isSafeInteger(value) && value >= 0
const share = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1

const REFUSALS = {
  concurrency: {
    status: 429,
    code: "MODEL_PLAN_CONCURRENCY",
    message: "Your Codium requests are busy. Wait for a request to finish and try again.",
  },
  busy: { status: 429, code: "MODEL_PLAN_BUSY", message: "Vector Codium is busy. Try again shortly." },
  daily: {
    status: 429,
    code: "MODEL_PLAN_DAILY_LIMIT",
    message: "Your Codium daily limit has been reached. Try again tomorrow.",
  },
  brain: { status: 429, code: "MODEL_PLAN_BRAIN_SHARE", message: "Codium Brain has reached its share for this month." },
  run: {
    status: 429,
    code: "MODEL_PLAN_RUN_LIMIT",
    message: "This run has reached its Codium limit. Save your work and finish the run.",
  },
  runexpired: {
    status: 401,
    code: "MODEL_PLAN_RUN_EXPIRED",
    message: "This run is no longer authorized. Save your work and start a new run.",
  },
} as const

const ADMIT =
  MODEL_SPEND_LUA +
  `
local p = object(ARGV[1])
if not p or not integer(p.admittedAt) or not integer(p.deadline) or p.deadline ~= p.admittedAt + 660000 or not integer(p.micro) or p.micro == 0 or type(p.fence) ~= 'table' or p.fence.now ~= p.admittedAt or p.fence.version ~= p.version or p.fence.pool ~= p.pool or p.fence.account ~= p.account or not integer(p.fence.start) or not integer(p.fence['end']) or p.periodEnd ~= p.fence['end'] * 1000 then return 'unavailable' end
local funding = p.fence
local spend = model_spend_read(KEYS[5], KEYS[6], KEYS[3], KEYS[4], p.admittedAt, p.account, p.pool)
if not spend or spend.records[p.ticket] then return 'unavailable' end
local refusal, snapshot = model_pool_fence(KEYS[1], KEYS[2], funding, spend)
if refusal then return refusal end
if snapshot.meterEpoch ~= p.epoch then return 'stale' end
local caps = snapshot.caps
local function fraction(value) return type(value) == 'number' and value >= 0 and value <= 1 end
if not caps or not integer(caps.rank) or caps.rank < 1 or caps.rank > 4 or not integer(caps.inFlight) or caps.inFlight < 1 or (caps.dailyShare ~= cjson.null and not fraction(caps.dailyShare)) or type(caps.purposeShare) ~= 'table' or not fraction(caps.purposeShare.brain) or type(caps.cloudAgents) ~= 'table' or not fraction(caps.cloudAgents.runCeilingShare) or not purposes[p.purpose] then return 'unavailable' end
for i = 7, 8 do if not typed(KEYS[i], 'zset') then return 'unavailable' end end
if not typed(KEYS[9], 'hash') or not typed(KEYS[10], 'hash') or not typed(KEYS[11], 'string') then return 'unavailable' end
if p.run and not model_run_pool(KEYS[12], p.pool) then return 'runexpired' end
-- §4.7: purge expired members, then count the live ones. A member past its deadline (scored at or before this
-- admission) holds no slot; removing it changes no answer, and keeps the global set small through refusal bursts.
-- Counting is ZCOUNT, O(log N), never a walk of the global set. The bound is formatted: Lua's %.14g would round it.
local admitted = string.format('%.0f', p.admittedAt)
for i = 7, 8 do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', admitted) end
local function live_count(key) return redis.call('ZCOUNT', key, '(' .. admitted, '+inf') end
-- Refusal precedence is contractual: account, global, month, day, period Brain, run.
if live_count(KEYS[7]) >= caps.inFlight then return 'concurrency' end
if p.globalLimit ~= nil then
  if not integer(p.globalLimit) or p.globalLimit < 1 or not fraction(p.priorityReserve) then return 'unavailable' end
  local limit = caps.rank >= 3 and p.globalLimit or p.globalLimit - math.ceil(p.globalLimit * p.priorityReserve)
  if live_count(KEYS[8]) >= limit then return 'busy' end
end
local observed = integer(p.observedMicro)
if not observed then return 'unavailable' end
local burden = plus(plus(plus(math.max(observed, spend.committed), spend.reserved), spend.nonmodelHeld), spend.applied)
if not burden then return 'unavailable' end
if funding.totalMicro - burden < p.micro then return 'monthly' end
local daily = integer(redis.call('HGET', KEYS[9], 'total') or '0')
local brain = integer(redis.call('HGET', KEYS[10], 'brain') or '0')
local run = integer(redis.call('GET', KEYS[11]) or '0')
if not daily or not brain or not run then return 'unavailable' end
for _, record in pairs(spend.records) do
  if record.state == 'open' then
    if record.day == p.day then daily = plus(daily, record.micro) end
    if record.purpose == 'brain' then brain = plus(brain, record.micro) end
    if p.run and record.run == p.run and record.runUntil > p.admittedAt then run = plus(run, record.micro) end
    if not daily or not brain or not run then return 'unavailable' end
  end
end
-- Existing nonmodel holds have no admission date. Counting each live unknown-day hold today is conservative.
for _, held in ipairs(spend.holds) do
  daily = plus(daily, held.micro)
  if held.purpose == 'brain' then brain = plus(brain, held.micro) end
  if p.run and held.run == p.run then run = plus(run, held.micro) end
  if not daily or not brain or not run then return 'unavailable' end
end
local dayStart = p.admittedAt - (p.admittedAt % 86400000)
for _, debit in ipairs(spend.debits) do
  if debit.at >= dayStart and debit.at < dayStart + 86400000 then daily = plus(daily, debit.micro) end
  if debit.purpose == 'brain' then brain = plus(brain, debit.micro) end
  if p.run and debit.run == p.run then run = plus(run, debit.micro) end
  if not daily or not brain or not run then return 'unavailable' end
end
local dailyNext, brainNext, runNext = plus(daily, p.micro), plus(brain, p.micro), plus(run, p.micro)
if not dailyNext or not brainNext or not runNext then return 'unavailable' end
if caps.dailyShare ~= cjson.null and dailyNext > math.floor(funding.totalMicro * caps.dailyShare) then return 'daily' end
if p.purpose == 'brain' and brainNext > math.floor(funding.totalMicro * caps.purposeShare.brain) then return 'brain' end
if p.run then
  if type(p.run) ~= 'string' or #p.run > 128 or p.run == '-' or not string.match(p.run, '^[%w_.-]+$') or not integer(p.runDeadline) or p.runDeadline <= p.admittedAt or (p.runShare ~= nil and not fraction(p.runShare)) then return 'unavailable' end
  local ceiling = math.min(p.runShare or 1, caps.cloudAgents.runCeilingShare, caps.dailyShare ~= cjson.null and caps.dailyShare or 1)
  if runNext > math.floor(funding.totalMicro * ceiling) then return 'run' end
end
local record = {account=p.account,pool=p.pool,ticket=p.ticket,member=p.member,purpose=p.purpose,run=p.run,micro=p.micro,day=p.day,epoch=p.epoch,version=p.version,deadline=p.deadline,periodEnd=p.periodEnd,admittedAt=p.admittedAt,runUntil=p.runUntil,state='open'}
local parsed = member(record.member)
if not parsed or parsed.ticket ~= record.ticket or parsed.purpose ~= record.purpose or parsed.run ~= (record.run or '-') or parsed.micro ~= record.micro then return 'unavailable' end
local keep = math.max(p.periodEnd + 3456000000, p.runUntil, p.deadline + 30000)
local nextReserved, nextOpen = plus(spend.reserved, p.micro), plus(spend.openCount, 1)
if not nextReserved or not nextOpen then return 'unavailable' end
model_spend_compact(spend, KEYS[5], KEYS[6])
local reservationsNew = redis.call('EXISTS', KEYS[6]) == 0
redis.call('HSET', KEYS[6], p.ticket, model_record_encode(record))
redis.call('HSET', KEYS[5], 'reserved', string.format('%.0f', nextReserved), 'openCount', string.format('%.0f', nextOpen))
if p.run then model_bind_run_pool(KEYS[12], p.pool, p.runUntil, p.admittedAt) end
if reservationsNew then redis.call('PEXPIREAT', KEYS[6], keep) else grow(KEYS[6], keep, p.admittedAt) end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', p.admittedAt)
local heldNew = redis.call('EXISTS', KEYS[3]) == 0
redis.call('ZADD', KEYS[3], p.deadline, p.member)
for i = 7, 8 do
  local fresh = redis.call('EXISTS', KEYS[i]) == 0
  redis.call('ZADD', KEYS[i], p.deadline, p.account .. ':' .. p.ticket)
  -- A later short request may never shorten an earlier live reservation.
  if fresh then redis.call('PEXPIREAT', KEYS[i], p.deadline) else grow(KEYS[i], p.deadline, p.admittedAt) end
end
if heldNew then redis.call('PEXPIREAT', KEYS[3], p.deadline) else grow(KEYS[3], p.deadline, p.admittedAt) end
return 'ok'
`

const SETTLE =
  MODEL_SPEND_LUA +
  `
local p, kind, charge, now = object(ARGV[1]), ARGV[2], integer(ARGV[3]), integer(ARGV[4])
if not p or not charge or not now or (kind ~= 'cancel' and kind ~= 'complete' and kind ~= 'broken') then return 'unavailable' end
local spend = model_spend_read(KEYS[5], KEYS[6], KEYS[3], KEYS[4], now, p.account, p.pool)
if not spend then return 'unavailable' end
local record = spend.records[p.ticket]
if not record then return 'missing' end
for _, field in ipairs({'account','pool','ticket','member','purpose','run','micro','day','epoch','version','deadline','periodEnd','admittedAt','runUntil'}) do
  if record[field] ~= p[field] then return 'unavailable' end
end
if record.state == 'done' then return 'done' end
if (kind == 'cancel' and charge ~= 0) or (kind == 'broken' and charge > record.micro) then return 'unavailable' end
for i = 7, 8 do if not typed(KEYS[i], 'zset') then return 'unavailable' end end
if not typed(KEYS[9], 'hash') or not typed(KEYS[10], 'hash') or not typed(KEYS[11], 'string') then return 'unavailable' end
local daily = integer(redis.call('HGET', KEYS[9], 'total') or '0')
local dailyBrain = integer(redis.call('HGET', KEYS[9], 'brain') or '0')
local brain = integer(redis.call('HGET', KEYS[10], 'brain') or '0')
local run = integer(redis.call('GET', KEYS[11]) or '0')
local committed = plus(spend.committed, charge)
local nextDaily = plus(daily, charge)
local nextDailyBrain = plus(dailyBrain, record.purpose == 'brain' and charge or 0)
local nextBrain = plus(brain, record.purpose == 'brain' and charge or 0)
local nextRun = plus(run, record.run and charge or 0)
if not committed or not nextDaily or not nextDailyBrain or not nextBrain or not nextRun then return 'unavailable' end
local dayNew, purposeNew, runNew = redis.call('EXISTS', KEYS[9]) == 0, redis.call('EXISTS', KEYS[10]) == 0, redis.call('EXISTS', KEYS[11]) == 0
record.state, record.charge, record.kind = 'done', charge, kind
record.gcAt = math.max(record.deadline, now + 30000)
model_spend_compact(spend, KEYS[5], KEYS[6])
redis.call('HSET', KEYS[6], p.ticket, model_record_encode(record))
redis.call('HSET', KEYS[5], 'committed', string.format('%.0f', committed), 'reserved', string.format('%.0f', spend.reserved - record.micro), 'openCount', string.format('%.0f', spend.openCount - 1))
-- Immutable original budget keys are used even after an upgrade or UTC midnight.
local keep = record.periodEnd + 3456000000
if now < keep then
  redis.call('HSET', KEYS[9], 'total', string.format('%.0f', nextDaily), 'brain', string.format('%.0f', nextDailyBrain))
  redis.call('HSET', KEYS[10], 'brain', string.format('%.0f', nextBrain))
  if dayNew then redis.call('PEXPIREAT', KEYS[9], keep) else grow(KEYS[9], keep, now) end
  if purposeNew then redis.call('PEXPIREAT', KEYS[10], keep) else grow(KEYS[10], keep, now) end
end
if record.run and now < record.runUntil then
  redis.call('SET', KEYS[11], string.format('%.0f', nextRun), 'KEEPTTL')
  if runNew then redis.call('PEXPIREAT', KEYS[11], record.runUntil) else grow(KEYS[11], record.runUntil, now) end
end
for i = 7, 8 do redis.call('ZREM', KEYS[i], p.account .. ':' .. p.ticket) end
-- Expiry cannot resurrect a monthly hold. The durable floor above still records late actual/unknown charges.
local wasHeld = redis.call('ZSCORE', KEYS[3], record.member)
if kind ~= 'broken' then redis.call('ZREM', KEYS[3], record.member) end
if kind == 'complete' and wasHeld and tonumber(wasHeld) > now and now < record.deadline and charge > 0 then
  local bridge = record.ticket .. ':' .. record.purpose .. ':' .. (record.run or '-') .. ':' .. string.format('%.0f', charge)
  local fresh = redis.call('EXISTS', KEYS[3]) == 0
  redis.call('ZADD', KEYS[3], now + 30000, bridge)
  if fresh then redis.call('PEXPIREAT', KEYS[3], now + 30000) else grow(KEYS[3], now + 30000, now) end
end
return 'ok'
`

export const ADMISSION_SCRIPTS = Object.freeze({ ADMIT, SETTLE })
