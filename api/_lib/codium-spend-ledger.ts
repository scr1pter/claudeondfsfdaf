import { codiumKey } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/** A genesis belongs to one newly created, never exposed provider key. Times are seconds. */
export type ModelSpendGenesis = {
  account: string
  pool: string
  subscription: string
  start: number
  end: number
  creation: string
}

export const modelSpendKeys = (pool: string) => ({
  ledger: codiumKey("model-spend", pool),
  reservations: codiumKey("model-reservations", pool),
})

/** A run cannot silently reset its budget by changing the monthly key underneath it. */
export const runPoolKey = (run: string) => codiumKey("run-pool", run)

/** Shared Lua is used by both atomic model admission and nonmodel pool HOLD/READ. */
export const MODEL_SPEND_LUA = `
local SAFE = 9007199254740991
local function integer(value, signed)
  local n = tonumber(value)
  if not n or n ~= n or n > SAFE or n < (signed and -SAFE or 0) or n ~= math.floor(n) then return nil end
  return n
end
local function plus(a, b)
  if not a or not b or a > SAFE - b then return nil end
  return a + b
end
local function object(raw)
  if type(raw) ~= 'string' then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' then return nil end
  return value
end
local function typed(key, expected)
  local t = redis.call('TYPE', key)
  if type(t) == 'table' then t = t.ok end
  return t == 'none' or t == expected
end
local function grow(key, at, now)
  local ttl = redis.call('PTTL', key)
  if ttl ~= -1 and ttl < at - now then redis.call('PEXPIREAT', key, at) end
end
-- Called before any write. A mismatching existing binding is an expired run, never a fresh budget.
local function model_run_pool(key, pool)
  if not typed(key, 'string') then return false end
  local previous = redis.call('GET', key)
  return not previous or previous == pool
end
local function model_bind_run_pool(key, pool, untilAt, now)
  local fresh = redis.call('EXISTS', key) == 0
  redis.call('SET', key, pool, 'KEEPTTL')
  if fresh then redis.call('PEXPIREAT', key, untilAt) else grow(key, untilAt, now) end
end
local purposes = {chat=true,title=true,brain=true,review=true,judge=true,race=true,playbook=true,task=true,['cloud-agents']=true,hosted=true}
local function member(raw)
  if type(raw) ~= 'string' then return nil end
  local ticket, purpose, run, amount = string.match(raw, '^([%w-]+):([a-z][a-z0-9-]*):([%w_.-]+):(%d+)$')
  local micro = integer(amount)
  if not ticket or #ticket > 64 or not purposes[purpose] or #run > 128 or not micro then return nil end
  return {ticket=ticket,purpose=purpose,run=run,micro=micro}
end
local recordNumbers = {'micro','deadline','admittedAt','periodEnd','runUntil','version','charge','gcAt'}
local function model_record_encode(record)
  local stored = {}
  for key, value in pairs(record) do stored[key] = value end
  -- Redis cjson emits at most 14 significant digits. Decimal strings preserve every accepted safe integer.
  for _, key in ipairs(recordNumbers) do
    if stored[key] ~= nil then stored[key] = string.format('%.0f', stored[key]) end
  end
  return cjson.encode(stored)
end
-- No mutation occurs here. Both HOLD and ADMIT must use this SAME floor, including abandoned model reservations.
-- Committed is a provider-usage floor, not a provider-key limit reduction. Open reservations are additional holds; one
-- past its deadline is abandoned (its outcome is unknown) and keeps counting at its full amount.
local function model_spend_read(ledgerKey, reservationsKey, heldKey, debitsKey, now, account, pool)
  if not integer(now) or not typed(ledgerKey, 'hash') or not typed(reservationsKey, 'hash') or not typed(heldKey, 'zset') or not typed(debitsKey, 'hash') then return nil end
  local genesis = object(redis.call('HGET', ledgerKey, 'genesis'))
  local committed = integer(redis.call('HGET', ledgerKey, 'committed'))
  local compacted = integer(redis.call('HGET', ledgerKey, 'compacted'))
  local expectedReserved = integer(redis.call('HGET', ledgerKey, 'reserved'))
  local expectedOpen = integer(redis.call('HGET', ledgerKey, 'openCount'))
  if not genesis or genesis.v ~= 1 or genesis.account ~= account or genesis.pool ~= pool or type(genesis.creation) ~= 'string' or type(genesis.subscription) ~= 'string' or not integer(genesis.start) or not integer(genesis['end']) or genesis['end'] <= genesis.start or not committed or not compacted or not expectedReserved or not expectedOpen then return nil end
  local records, reserved, abandoned, done, openCount, gc, gcMicro = {}, 0, 0, compacted, 0, {}, 0
  local rawRecords = redis.call('HGETALL', reservationsKey)
  -- No admission writes a model 'group' since the Astra in-flight cap was retired (owner, 30 Oct). A record that still
  -- names one came from that retired path and is refused like any other malformed record: the ledger fails closed.
  for i = 1, #rawRecords, 2 do
    local record = object(rawRecords[i + 1])
    if record then
      for _, key in ipairs(recordNumbers) do
        if record[key] ~= nil then
          local value = integer(record[key])
          if not value then return nil end
          record[key] = value
        end
      end
    end
    local held = record and member(record.member)
    if not record or not held or record.ticket ~= rawRecords[i] or held.ticket ~= record.ticket or record.account ~= account or record.pool ~= pool or not integer(record.micro) or held.micro ~= record.micro or held.purpose ~= record.purpose or held.run ~= (record.run or '-') or type(record.day) ~= 'string' or not string.match(record.day, '^%d%d%d%d%-%d%d%-%d%d$') or not integer(record.deadline) or not integer(record.admittedAt) or not integer(record.periodEnd) or not integer(record.runUntil) or type(record.epoch) ~= 'string' or not integer(record.version) or record.group ~= nil then return nil end
    if record.state == 'open' then
      reserved = plus(reserved, record.micro)
      openCount = openCount + 1
      if not reserved then return nil end
      if record.deadline <= now then
        abandoned = plus(abandoned, record.micro)
        if not abandoned then return nil end
      end
    elseif record.state == 'done' and integer(record.charge) and integer(record.gcAt) and record.gcAt >= record.deadline and (record.kind == 'cancel' or record.kind == 'complete' or record.kind == 'broken') then
      done = plus(done, record.charge)
      if not done then return nil end
      if record.gcAt <= now then
        table.insert(gc, record.ticket)
        gcMicro = plus(gcMicro, record.charge)
        if not gcMicro then return nil end
      end
    else return nil end
    records[record.ticket] = record
  end
  -- A missing or corrupt reservation cannot silently lower the committed floor.
  if done ~= committed or reserved ~= expectedReserved or openCount ~= expectedOpen then return nil end
  local applied, pending, debits, debitHolds = 0, 0, {}, {}
  local rawDebits = redis.call('HGETALL', debitsKey)
  for i = 1, #rawDebits, 2 do
    local debit = object(rawDebits[i + 1])
    local held = debit and member(debit.hold)
    if not debit or not held or not integer(debit.micro) or type(debit.applied) ~= 'boolean' or not integer(debit.at) or not purposes[debit.purpose] or (debit.run ~= nil and (type(debit.run) ~= 'string' or #debit.run > 128 or not string.match(debit.run, '^[%w_.-]+$') or debit.run == '-')) or held.micro ~= debit.micro or held.purpose ~= debit.purpose or held.run ~= (debit.run or '-') then return nil end
    if debit.applied then applied = plus(applied, debit.micro) else pending = plus(pending, debit.micro) end
    if not applied or not pending then return nil end
    debitHolds[debit.hold] = true
    table.insert(debits, debit)
  end
  local nonmodelHeld, heldRecords = 0, {}
  local rawHeld = redis.call('ZRANGE', heldKey, 0, -1, 'WITHSCORES')
  for i = 1, #rawHeld, 2 do
    local held, score = member(rawHeld[i]), integer(rawHeld[i + 1])
    if not held or not score then return nil end
    local record = records[held.ticket]
    if record then
      if held.purpose ~= record.purpose or held.run ~= (record.run or '-') or (rawHeld[i] ~= record.member and (record.state ~= 'done' or held.micro ~= record.charge)) then return nil end
    elseif score > now then
      nonmodelHeld = plus(nonmodelHeld, held.micro)
      if not nonmodelHeld then return nil end
      if not debitHolds[rawHeld[i]] then table.insert(heldRecords, held) end
    end
  end
  for _, debit in ipairs(debits) do
    if not debit.applied then
      local score = integer(redis.call('ZSCORE', heldKey, debit.hold))
      local parsed = member(debit.hold)
      if not score or score <= now or records[parsed.ticket] then return nil end
    end
  end
  return {genesis=genesis,committed=committed,compacted=compacted,reserved=reserved,abandoned=abandoned,openCount=openCount,nonmodelHeld=nonmodelHeld,applied=applied,pending=pending,records=records,debits=debits,holds=heldRecords,gc=gc,gcMicro=gcMicro}
end
-- The exact private record, key, genesis, period and snapshot a hold or an admission was priced against (handoff 8.7
-- items 1-2). Any billing write since (a key replacement's barrier, an upgrade, a risk or closing intent) or a period
-- that moved on is 'stale': the caller reads again and retries. Anything that contradicts the trusted genesis or the
-- integer pool is 'unavailable', which is final. ADMIT and the common HOLD share this one predicate.
local function model_pool_fence(accountKey, entKey, f, spend)
  if type(f) ~= 'table' or type(f.accountRecord) ~= 'string' or not integer(f.now) or not integer(f.graceMs) or not integer(f.start) or not integer(f['end']) or not integer(f.totalMicro) or not typed(accountKey, 'string') or not typed(entKey, 'string') then return 'unavailable' end
  if redis.call('GET', accountKey) ~= f.accountRecord then return 'stale' end
  local account = object(f.accountRecord)
  local key = account and account.key
  if type(key) ~= 'table' then return 'unavailable' end
  local risk = account.risk
  if account.closing or account.upgrade or account.keyCreation or account.transition or (account.ownerEnd and not account.ownerEnd.done) or key.provisioning or key.revoked or (risk and (type(risk) ~= 'table' or risk.blocked ~= false or type(risk.openDisputes) ~= 'table' or next(risk.openDisputes) ~= nil or type(risk.efw) ~= 'table' or next(risk.efw) ~= nil)) then return 'stale' end
  -- Only integer pools have a genesis. A decimal or test-capped legacy figure is never reconstructed here.
  local carry = key.carry
  local total = plus(integer(key.creditsMicro), carry == nil and 0 or (type(carry) == 'table' and integer(carry.micro) or nil))
  local proof = key.spendGenesis
  if type(proof) ~= 'table' or proof.state ~= 'ready' or proof.nonce ~= spend.genesis.creation or key.hash ~= f.pool or key.subscription ~= f.subscription or key.start ~= f.start or key['end'] ~= f['end'] or spend.genesis.subscription ~= f.subscription or spend.genesis.start ~= f.start or spend.genesis['end'] ~= f['end'] or not total or total ~= f.totalMicro then return 'unavailable' end
  local snapshot = object(redis.call('GET', entKey))
  if not snapshot then return 'stale' end
  if snapshot.v ~= 1 or snapshot.account ~= f.account or snapshot.livemode ~= f.livemode then return 'unavailable' end
  if snapshot.subscription ~= f.subscription or snapshot.periodStart ~= f.start * 1000 or snapshot.periodEnd ~= f['end'] * 1000 or snapshot.meterEpoch ~= f.subscription .. ':' .. string.format('%.0f', snapshot.periodStart) or (f.version ~= nil and snapshot.version ~= f.version) or f.now < snapshot.periodStart then return 'stale' end
  if snapshot.state == 'active' then
    if f.now >= snapshot.periodEnd then return 'stale' end
  elseif snapshot.state ~= 'renewing' or f.now >= snapshot.periodEnd + f.graceMs then return 'stale' end
  return nil, snapshot
end
-- Compaction is invoked only after all read/validation gates pass. Counter integrity preserves a missing open
-- reservation as an error; expired completed identities can safely disappear without ever reopening their spend.
local function model_spend_compact(value, ledgerKey, reservationsKey)
  if #value.gc == 0 then return end
  for _, ticket in ipairs(value.gc) do redis.call('HDEL', reservationsKey, ticket) end
  redis.call('HSET', ledgerKey, 'compacted', string.format('%.0f', value.compacted + value.gcMicro))
end
`

export async function initializeFreshModelPool(input: ModelSpendGenesis, fetcher: typeof fetch = fetch) {
  if (
    !Number.isSafeInteger(input.start) ||
    input.start < 0 ||
    !Number.isSafeInteger(input.end) ||
    input.end <= input.start ||
    !Number.isSafeInteger(input.end * 1000 + 40 * 86_400_000) ||
    !/^[A-Za-z0-9-]{1,64}$/.test(input.creation)
  )
    throw modelSpendUnavailable()
  const result = await persistentStore(
    [
      "EVAL",
      MODEL_SPEND_SCRIPTS.GENESIS,
      3,
      codiumKey("account", input.account),
      modelSpendKeys(input.pool).ledger,
      modelSpendKeys(input.pool).reservations,
      JSON.stringify({ v: 1, ...input }),
    ],
    fetcher,
  )
  if (result !== 1) throw modelSpendUnavailable()
}

export async function readModelSpendLedger(account: string, pool: string, now: number, fetcher: typeof fetch = fetch) {
  if (!Number.isSafeInteger(now) || now < 0) throw modelSpendUnavailable()
  const result = await persistentStore(
    [
      "EVAL",
      MODEL_SPEND_SCRIPTS.READ,
      4,
      modelSpendKeys(pool).ledger,
      modelSpendKeys(pool).reservations,
      codiumKey("held", pool),
      codiumKey("debits", account, pool),
      now,
      account,
      pool,
    ],
    fetcher,
  )
  const values = Array.isArray(result) ? result.map(Number) : []
  if (values.length !== 6 || values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw modelSpendUnavailable()
  return {
    committedMicro: values[0]!,
    /** Every open model reservation, live or abandoned. */
    reservedMicro: values[1]!,
    /** Open model reservations past their deadline: unknown outcomes that keep counting at their full amount. */
    abandonedMicro: values[2]!,
    /** Live nonmodel holds, including the holds that keep pending debits counted. */
    nonmodelHeldMicro: values[3]!,
    appliedMicro: values[4]!,
    pendingMicro: values[5]!,
  }
}

const GENESIS =
  MODEL_SPEND_LUA +
  `
local input = object(ARGV[1])
if not input or input.v ~= 1 or type(input.account) ~= 'string' or type(input.pool) ~= 'string' or type(input.subscription) ~= 'string' or type(input.creation) ~= 'string' or #input.creation > 64 or not string.match(input.creation, '^[%w-]+$') or not integer(input.start) or not integer(input['end']) or not integer(input['end'] * 1000 + 3456000000) or input['end'] <= input.start or not typed(KEYS[1], 'string') or not typed(KEYS[2], 'hash') or not typed(KEYS[3], 'hash') then return 0 end
local accountRaw = redis.call('GET', KEYS[1])
local account = object(accountRaw)
local key = account and account.key
local proof = key and key.spendGenesis
if not key or not proof or proof.nonce ~= input.creation or key.hash ~= input.pool or key.subscription ~= input.subscription or key.start ~= input.start or key['end'] ~= input['end'] then return 0 end
local existing = redis.call('HGET', KEYS[2], 'genesis')
if existing then
  local old = object(existing)
  if proof.state == 'ready' and old and old.v == 1 and old.account == input.account and old.pool == input.pool and old.creation == input.creation and old.subscription == input.subscription and old.start == input.start and old['end'] == input['end'] and integer(redis.call('HGET', KEYS[2], 'committed')) and integer(redis.call('HGET', KEYS[2], 'compacted')) and integer(redis.call('HGET', KEYS[2], 'reserved')) and integer(redis.call('HGET', KEYS[2], 'openCount')) then return 1 end
  return 0
end
-- A legacy published key CANNOT acquire a zero baseline from a usage observation. Only the private publication
-- barrier proves this provider key has never been exposed. The creator is the only caller of this initializer.
if proof.state ~= 'pending' or key.provisioning ~= true or key.revoked or redis.call('EXISTS', KEYS[2]) ~= 0 or redis.call('EXISTS', KEYS[3]) ~= 0 then return 0 end
local needle = '"spendGenesis":{"nonce":"' .. input.creation .. '","state":"pending"}'
local first, last = string.find(accountRaw, needle, 1, true)
if not first or string.find(accountRaw, needle, last + 1, true) then return 0 end
local ready = '"spendGenesis":{"nonce":"' .. input.creation .. '","state":"ready"}'
redis.call('HSET', KEYS[2], 'genesis', ARGV[1], 'committed', '0', 'compacted', '0', 'reserved', '0', 'openCount', '0')
redis.call('PEXPIREAT', KEYS[2], input['end'] * 1000 + 3456000000)
-- Splice the verified marker. cjson.encode(account) would turn empty JSON arrays into objects.
redis.call('SET', KEYS[1], string.sub(accountRaw, 1, first - 1) .. ready .. string.sub(accountRaw, last + 1))
return 1
`

const READ =
  MODEL_SPEND_LUA +
  `
local value = model_spend_read(KEYS[1], KEYS[2], KEYS[3], KEYS[4], integer(ARGV[1]), ARGV[2], ARGV[3])
if not value then return {-1} end
model_spend_compact(value, KEYS[1], KEYS[2])
return {value.committed,value.reserved,value.abandoned,value.nonmodelHeld,value.applied,value.pending}
`

/*
 * DAY. What one pool has spent against today's daily share, counted as ADMIT counts it before adding a request
 * (model-plan-admit.ts) less the model requests still running: the settled day bucket (KEYS[5]), every open reservation
 * admitted today (ARGV[4], the UTC date) once past its deadline (abandoned: its outcome is unknown and it counts in
 * full), every live nonmodel hold (a hold has no admission day, so ADMIT counts each one today) and every debit
 * recorded today. A live reservation settles within minutes, usually for far less, so status's meter does not jump by
 * it, as its month's `empty` does not. Read only: status shows it, and ADMIT alone decides. -1 when the ledger cannot
 * be trusted.
 */
const DAY =
  MODEL_SPEND_LUA +
  `
local now = integer(ARGV[1])
local spend = model_spend_read(KEYS[1], KEYS[2], KEYS[3], KEYS[4], now, ARGV[2], ARGV[3])
if not spend or not typed(KEYS[5], 'hash') then return -1 end
local daily = integer(redis.call('HGET', KEYS[5], 'total') or '0')
if not daily then return -1 end
for _, record in pairs(spend.records) do
  if record.state == 'open' and record.day == ARGV[4] and record.deadline <= now then daily = plus(daily, record.micro) end
  if not daily then return -1 end
end
for _, held in ipairs(spend.holds) do
  daily = plus(daily, held.micro)
  if not daily then return -1 end
end
local dayStart = now - (now % 86400000)
for _, debit in ipairs(spend.debits) do
  if debit.at >= dayStart and debit.at < dayStart + 86400000 then daily = plus(daily, debit.micro) end
  if not daily then return -1 end
end
return daily
`

export const MODEL_SPEND_SCRIPTS = Object.freeze({ GENESIS, READ, DAY })

/**
 * Today's spend on `pool` against the daily share (DAY), in integer micro-dollars: ADMIT's figure without the model
 * requests still running.
 */
export async function readModelSpendDay(account: string, pool: string, now: number, fetcher: typeof fetch = fetch) {
  if (!Number.isSafeInteger(now) || now < 0) throw modelSpendUnavailable()
  const day = new Date(now).toISOString().slice(0, 10)
  const result = Number(
    await persistentStore(
      [
        "EVAL",
        DAY,
        5,
        modelSpendKeys(pool).ledger,
        modelSpendKeys(pool).reservations,
        codiumKey("held", pool),
        codiumKey("debits", account, pool),
        codiumKey("day", pool, day),
        now,
        account,
        pool,
        day,
      ],
      fetcher,
    ),
  )
  if (!Number.isSafeInteger(result) || result < 0) throw modelSpendUnavailable()
  return result
}

export function modelSpendUnavailable() {
  return new ApiError(503, "MODEL_PLAN_POOL_UNAVAILABLE", "Your Codium usage could not be verified.")
}

/** A fence race: a newer billing write or period exists. The client reads again after a moment. */
export function modelSpendStale() {
  return new ApiError(503, "MODEL_PLAN_RENEWING", "Your Codium access is updating. Try again shortly.", {
    retryAfterSeconds: 1,
  })
}

// A pool that is used up, too small for the model's largest request, or held by requests still running gets one
// answer. A different answer for each would tell a client which side of a threshold its balance is on, and with the
// share of a plan it has used, the allowance and so the markup. Codium sells monthly plans only, so the answer offers
// nothing to buy, and like every answer it names no amount and no credits (P1). ADMIT and every hold give this answer.
export function monthlyShortfall() {
  return new ApiError(
    402,
    "MODEL_PLAN_EXHAUSTED",
    "This month's Vector Codium usage cannot cover this model's largest request right now. Wait for running requests to finish, or choose a lighter model. Your Codium usage renews each billing period.",
  )
}
