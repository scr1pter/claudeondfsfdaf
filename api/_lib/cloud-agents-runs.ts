import { Option, Schema } from "effect"
import { GithubAgents } from "../../packages/core/src/github-agents.js"
import { bindingKey, bindingsForAccount, generationKey, revokeBinding } from "./cloud-agents-binding.js"
import { RUN_SOURCES, type RunSource, type RunTrigger } from "./cloud-agents-entitlement.js"
import { liveKey, runRecordKey, type LedgerPurpose, type LedgerSource } from "./cloud-agents-ledger.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

const PREFIX = "vector:cloud-agents:"
const RETENTION = 90 * 86_400
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RID = /^gh-([1-9]\d{0,15})-([1-9]\d{0,15})-([1-9]\d{0,15})-([1-9]\d{0,15})$/
const Decimal = Schema.String.check(
  Schema.makeFilter((value: string) => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))),
)
const Account = Schema.String.check(Schema.isPattern(UUID))
const Jti = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/))
const Repository = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/))
const Actor = Schema.Struct({
  login: Schema.String.check(Schema.isPattern(/^(?:[A-Za-z0-9][A-Za-z0-9-]{0,38}|[a-z0-9][a-z0-9-]{0,98}\[bot\])$/)),
  id: Decimal,
})
const Trigger = Schema.Struct({
  source: Schema.Literals(RUN_SOURCES),
  purpose: Schema.Literals(["task", "review", "incident", "changes"]),
})
const Record = Schema.Struct({
  rid: Schema.String.check(Schema.isPattern(RID)),
  account: Account,
  repository: Repository,
  repositoryId: Decimal,
  runUrl: Schema.String,
  event: Schema.Literals(["issue_comment", "issues", "pull_request_review_comment", "workflow_dispatch", "schedule"]),
  source: Schema.Literals(["github-comment", "github-dispatch", "github-schedule"]),
  purpose: Schema.Literals(["task", "review", "scheduled"]),
  startedAt: Decimal,
  generation: Decimal,
  jti: Jti,
  triggerSource: Schema.optionalKey(Schema.Literals(RUN_SOURCES)),
  triggerPurpose: Schema.optionalKey(Schema.Literals(["task", "review", "incident", "changes"])),
  endedAt: Schema.optionalKey(Decimal),
  outcome: Schema.optionalKey(Schema.Literals(GithubAgents.OUTCOME)),
  verdict: Schema.optionalKey(Schema.Literals(["pass", "fail", "none"])),
}).check(
  Schema.makeFilter((record) => {
    const parts = RID.exec(record.rid)
    return (
      !!parts &&
      parts.slice(1).every((part) => Number.isSafeInteger(Number(part))) &&
      parts[1] === record.repositoryId &&
      record.runUrl === `https://github.com/${record.repository}/actions/runs/${parts[2]}` &&
      record.source ===
        (record.event === "schedule"
          ? "github-schedule"
          : record.event === "workflow_dispatch"
            ? "github-dispatch"
            : "github-comment") &&
      (record.source === "github-schedule") === (record.purpose === "scheduled") &&
      ((record.triggerSource === undefined && record.triggerPurpose === undefined) ||
        (record.source === "github-dispatch" &&
          record.triggerSource !== undefined &&
          record.triggerPurpose !== undefined &&
          record.purpose === (record.triggerPurpose === "review" ? "review" : "task"))) &&
      ((record.endedAt === undefined && record.outcome === undefined && record.verdict === undefined) ||
        (record.endedAt !== undefined &&
          record.outcome !== undefined &&
          Number(record.endedAt) >= Number(record.startedAt) &&
          record.verdict === verdict(record.outcome)))
    )
  }),
)
const decodeRecord = Schema.decodeUnknownOption(Record, { onExcessProperty: "error" })
const decodeActor = Schema.decodeUnknownOption(Actor, { onExcessProperty: "error" })
type StoredRun = typeof Record.Type

export type RunRecordIdentity = { account: string; generation: number; jti: string }
export type CloudRun = {
  rid: string
  repository?: string
  repositoryId: string
  runUrl?: string
  event: string
  source: RunSource
  purpose: LedgerPurpose
  startedAt: number
  endedAt?: number
  outcome?: GithubAgents.Outcome
  verdict?: "pass" | "fail" | "none"
  trigger?: { source: RunSource; purpose: RunTrigger["purpose"] }
  actor?: { login: string; id: string }
}
export type RunStart = RunRecordIdentity & {
  rid: string
  repository: string
  repositoryId: string
  runId: string
  event: string
  source: LedgerSource
  purpose: LedgerPurpose
  startedAt: number
  actor: { login: string; id: string }
  trigger?: CloudRun["trigger"]
}

export async function recordRunStart(input: RunStart, store = persistentStore): Promise<void> {
  if (
    !validIdentity(input) ||
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt <= 0 ||
    !Schema.is(Actor)(input.actor) ||
    (input.trigger !== undefined && !Schema.is(Trigger)(input.trigger))
  )
    throw invalidRequest()
  const record = Option.getOrUndefined(
    decodeRecord({
      rid: input.rid,
      account: input.account,
      repository: input.repository,
      repositoryId: input.repositoryId,
      runUrl: `https://github.com/${input.repository}/actions/runs/${input.runId}`,
      event: input.event,
      source: input.source,
      purpose: input.purpose,
      startedAt: String(input.startedAt),
      generation: String(input.generation),
      jti: input.jti,
      ...(input.trigger ? { triggerSource: input.trigger.source, triggerPurpose: input.trigger.purpose } : {}),
    }),
  )
  if (!record) throw invalidRequest()
  const reply = await command(
    [
      "EVAL",
      START,
      "7",
      runRecordKey(input.rid),
      actorKey(input.rid),
      runsKey(input.account),
      liveKey(input.account),
      bindingKey(input.repositoryId),
      generationKey(input.repositoryId),
      `vector:cli-revoked:${input.account}`,
      JSON.stringify(record),
      JSON.stringify(input.actor),
      RETENTION,
    ],
    store,
  )
  if (reply === "stale")
    throw new ApiError(503, "CLOUD_AGENTS_UNAVAILABLE", "The run changed before its record could be saved.")
  if (reply !== "ok") throw unavailable()
}

export async function recordRunEnd(
  rid: string,
  outcome: GithubAgents.Outcome,
  now: number,
  identity: RunRecordIdentity,
  store = persistentStore,
): Promise<boolean> {
  if (
    !RID.test(rid) ||
    !validIdentity(identity) ||
    !GithubAgents.OUTCOME.includes(outcome) ||
    !Number.isSafeInteger(now) ||
    now <= 0
  )
    throw invalidRequest()
  const reply = await command(
    [
      "EVAL",
      END,
      "2",
      runRecordKey(rid),
      `vector:cli-revoked:${identity.account}`,
      identity.account,
      identity.generation,
      identity.jti,
      now,
      outcome,
      verdict(outcome),
      RETENTION,
    ],
    store,
  )
  if (reply !== 0 && reply !== 1) throw unavailable()
  return reply === 1
}

export async function listCloudRuns(
  account: string,
  input: { limit?: number } = {},
  store = persistentStore,
): Promise<CloudRun[]> {
  const limit = input.limit ?? 20
  if (!Schema.is(Account)(account) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalidRequest()
  const ids = await command(["ZREVRANGE", runsKey(account), 0, limit - 1], store)
  if (!Array.isArray(ids) || ids.length > limit || !ids.every((id) => typeof id === "string" && RID.test(id)))
    throw unavailable()
  if (!ids.length) return []
  const reply = await command(
    [
      "EVAL",
      READ,
      1 + ids.length * 2,
      `${PREFIX}binder-left:${account}`,
      ...ids.flatMap((id) => [runRecordKey(id), actorKey(id)]),
    ],
    store,
  )
  if (
    !Array.isArray(reply) ||
    reply.length !== ids.length + 1 ||
    !Array.isArray(reply[0]) ||
    !reply[0].every(Schema.is(Decimal))
  )
    throw unavailable()
  const hidden = new Set<string>(reply[0])
  return ids.flatMap((rid, index) => {
    const row = reply[index + 1]
    if (!Array.isArray(row) || row.length !== 2) throw unavailable()
    const values = fields(row[0])
    if (!Object.keys(values).length) return []
    const record = Option.getOrUndefined(decodeRecord(values))
    if (!record || record.rid !== rid) throw unavailable()
    if (record.account !== account) return []
    const actorValues = fields(row[1])
    const actor = Object.keys(actorValues).length ? Option.getOrUndefined(decodeActor(actorValues)) : undefined
    if (Object.keys(actorValues).length && !actor) throw unavailable()
    return [publicRun(record, hidden.has(record.repositoryId) ? undefined : actor, hidden.has(record.repositoryId))]
  })
}

/** A57 revokes the account before erasure. Every delayed writer must observe that same mark atomically. */
export async function eraseCloudAgentsAccount(account: string, store = persistentStore): Promise<void> {
  if (!Schema.is(Account)(account)) throw invalidRequest()
  if (!(await command(["GET", `vector:cli-revoked:${account}`], store)))
    throw new ApiError(409, "ACCOUNT_REVOCATION_REQUIRED", "Stop this account's access before erasing its run records.")
  for (const binding of await bindingsForAccount(account, store))
    await revokeBinding(binding.repositoryId, account, store)
  // The index is intentionally capped; scan the record namespace too so trimmed records are erased.
  for (const pattern of [`${PREFIX}run:*`, `${PREFIX}bind-code:*`, `${PREFIX}ticket:*`, `${PREFIX}binder-ok:*`]) {
    await scan(pattern, store, async (key) => {
      if (key.startsWith(`${PREFIX}run:`)) {
        if (key.endsWith(":actor")) return
        const rid = key.slice(`${PREFIX}run:`.length)
        if (!RID.test(rid)) throw unavailable()
        const reply = await command(["EVAL", ERASE_RUN, "2", key, actorKey(rid), account], store)
        if (reply !== 0 && reply !== 1) throw unavailable()
        return
      }
      const reply = await command(
        ["EVAL", ERASE_JSON, "1", key, account, key.startsWith(`${PREFIX}binder-ok:`) ? "1" : "0"],
        store,
      )
      if (reply !== 0 && reply !== 1) throw unavailable()
    })
  }
  for (const pattern of [`${PREFIX}used:${account}:*`, `${PREFIX}sched:${account}:*`])
    await scan(pattern, store, async (key) => {
      await command(["DEL", key], store)
    })
  await command(
    ["DEL", `${PREFIX}bindings:${account}`, `${PREFIX}binder-left:${account}`, runsKey(account), liveKey(account)],
    store,
  )
}

function publicRun(record: StoredRun, actor: CloudRun["actor"], hidden: boolean): CloudRun {
  return {
    rid: record.rid,
    repositoryId: record.repositoryId,
    ...(hidden ? {} : { repository: record.repository, runUrl: record.runUrl, ...(actor ? { actor } : {}) }),
    event: record.event,
    source: record.source,
    purpose: record.purpose,
    startedAt: Number(record.startedAt),
    ...(record.endedAt === undefined
      ? {}
      : { endedAt: Number(record.endedAt), outcome: record.outcome, verdict: record.verdict }),
    ...(record.triggerSource === undefined
      ? {}
      : { trigger: { source: record.triggerSource, purpose: record.triggerPurpose! } }),
  }
}

async function scan(pattern: string, store: typeof persistentStore, visit: (key: string) => Promise<void>) {
  let cursor = "0"
  do {
    const reply = await command(["SCAN", cursor, "MATCH", pattern, "COUNT", 100], store)
    if (
      !Array.isArray(reply) ||
      reply.length !== 2 ||
      typeof reply[0] !== "string" ||
      !/^\d+$/.test(reply[0]) ||
      !Array.isArray(reply[1]) ||
      !reply[1].every((key) => typeof key === "string" && key.startsWith(pattern.slice(0, -1)))
    )
      throw unavailable()
    cursor = reply[0]
    for (const key of reply[1]) await visit(key)
  } while (cursor !== "0")
}

async function command(input: readonly (string | number)[], store: typeof persistentStore) {
  try {
    return await store(input)
  } catch {
    throw unavailable()
  }
}

function fields(value: unknown): Record<string, string> {
  if (!Array.isArray(value) || value.length % 2 || !value.every((item) => typeof item === "string")) throw unavailable()
  const result: Record<string, string> = Object.create(null)
  // The array is even-length and the loop advances by pairs, so both indexed strings exist.
  for (let i = 0; i < value.length; i += 2) {
    if (Object.hasOwn(result, value[i]!)) throw unavailable()
    result[value[i]!] = value[i + 1]!
  }
  return result
}

function validIdentity(input: RunRecordIdentity) {
  return (
    Schema.is(Account)(input.account) &&
    Number.isSafeInteger(input.generation) &&
    input.generation >= 1 &&
    Schema.is(Jti)(input.jti)
  )
}
function verdict(outcome: GithubAgents.Outcome) {
  return outcome === "changes" ? "pass" : outcome === "draft" || outcome === "failed" ? "fail" : "none"
}
function actorKey(rid: string) {
  return `${runRecordKey(rid)}:actor`
}
function runsKey(account: string) {
  return `${PREFIX}runs:${account}`
}
function invalidRequest() {
  return new ApiError(400, "INVALID_REQUEST", "Send only the supported run-record fields.")
}
function unavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Run records are temporarily unavailable.")
}

const TYPES = `
local function kind(key) return redis.call('TYPE', key).ok end
local function permits(key, expected) local got = kind(key); return got == 'none' or got == expected end
`
const START = `${TYPES}
if not permits(KEYS[1], 'hash') or not permits(KEYS[2], 'hash') or not permits(KEYS[3], 'zset')
  or not permits(KEYS[4], 'hash') or not permits(KEYS[5], 'hash') or not permits(KEYS[6], 'string')
  or not permits(KEYS[7], 'string') then return 'corrupt' end
local record = cjson.decode(ARGV[1])
if redis.call('GET', KEYS[7]) or redis.call('HGET', KEYS[5], 'account') ~= record.account
  or redis.call('HGET', KEYS[5], 'generation') ~= record.generation or redis.call('GET', KEYS[6]) ~= record.generation
  or redis.call('HEXISTS', KEYS[5], 'suspended') == 1 then return 'stale' end
local raw = redis.call('HGET', KEYS[4], record.rid)
if not raw then return 'stale' end
local decoded, live = pcall(cjson.decode, raw)
if not decoded or type(live) ~= 'table' then return 'corrupt' end
if live.jti ~= record.jti or live.gen ~= tonumber(record.generation) or live.startedAt ~= tonumber(record.startedAt)
  or live.repo ~= record.repositoryId or live.src ~= record.source or live.pur ~= record.purpose
  or live.triggerSource ~= record.triggerSource or live.triggerPurpose ~= record.triggerPurpose then return 'stale' end
local same = redis.call('HGET', KEYS[1], 'account') == record.account
  and redis.call('HGET', KEYS[1], 'generation') == record.generation
  and redis.call('HGET', KEYS[1], 'startedAt') == record.startedAt
if same and redis.call('HEXISTS', KEYS[1], 'endedAt') == 1 then return 'stale' end
if same then
  redis.call('HSET', KEYS[1], 'jti', record.jti)
else
  local fields = {}; for key, value in pairs(record) do table.insert(fields, key); table.insert(fields, value) end
  redis.call('DEL', KEYS[1], KEYS[2])
  redis.call('HSET', KEYS[1], unpack(fields))
  local actor = cjson.decode(ARGV[2])
  redis.call('HSET', KEYS[2], 'login', actor.login, 'id', actor.id)
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[3], record.startedAt, record.rid)
redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -201)
redis.call('EXPIRE', KEYS[3], ARGV[3])
return 'ok'
`
const END = `${TYPES}
if not permits(KEYS[1], 'hash') or not permits(KEYS[2], 'string') then return 'corrupt' end
if redis.call('GET', KEYS[2]) or redis.call('HGET', KEYS[1], 'account') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'generation') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'jti') ~= ARGV[3]
  or redis.call('HEXISTS', KEYS[1], 'endedAt') == 1 then return 0 end
local started = tonumber(redis.call('HGET', KEYS[1], 'startedAt'))
if not started or tonumber(ARGV[4]) < started then return 'corrupt' end
redis.call('HSET', KEYS[1], 'endedAt', ARGV[4], 'outcome', ARGV[5], 'verdict', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[7])
return 1
`
const READ = `${TYPES}
if not permits(KEYS[1], 'set') then return 'corrupt' end
local result = {redis.call('SMEMBERS', KEYS[1])}
for i = 2, #KEYS, 2 do
  if not permits(KEYS[i], 'hash') or not permits(KEYS[i + 1], 'hash') then return 'corrupt' end
  table.insert(result, {redis.call('HGETALL', KEYS[i]), redis.call('HGETALL', KEYS[i + 1])})
end
return result
`
const ERASE_RUN = `${TYPES}
if not permits(KEYS[1], 'hash') then return 'corrupt' end
if kind(KEYS[1]) == 'none' then return 0 end
local account = redis.call('HGET', KEYS[1], 'account')
if not account then return 'corrupt' end
if account ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2]); return 1
`
const ERASE_JSON = `${TYPES}
if not permits(KEYS[1], 'string') then return 'corrupt' end
local raw = redis.call('GET', KEYS[1]); if not raw then return 0 end
local decoded, record = pcall(cjson.decode, raw)
if not decoded or type(record) ~= 'table' then return 'corrupt' end
if record.account == nil and ARGV[2] == '1' then
  local count = 0; for _ in pairs(record) do count = count + 1 end
  if count ~= 2 or type(record.githubId) ~= 'string' or not string.match(record.githubId, '^[1-9]%d*$')
    or #record.githubId > 16 or tonumber(record.githubId) > 9007199254740991
    or type(record.generation) ~= 'number' or record.generation < 1 or record.generation > 9007199254740991
    or record.generation ~= math.floor(record.generation)
    then return 'corrupt' end
  local ttl = redis.call('TTL', KEYS[1]); if ttl < 0 or ttl > 3600 then return 'corrupt' end
  return 0
end
if type(record.account) ~= 'string' then return 'corrupt' end
if record.account ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1]); return 1
`
