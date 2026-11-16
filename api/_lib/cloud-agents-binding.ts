import { createHash, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import { GithubAgents } from "../../packages/core/src/github-agents.js"
import type { GithubIdentity } from "./github-oidc.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Repository bindings, bind codes and generations for @vector (vector-at-mention-spec 2.5 and 2.7, V05). V07's
 * run-token check reads bindings through bindingKey and generationKey; V10's bind API uses createBindCode,
 * peekBindCode, takeoverAllowed, redeemAndBind, bindingsForAccount and revokeBinding; V12's mint uses bindingFor,
 * touchBinding and suspendBinding; V28's webhooks use bindingFor, suspendBinding and renameBinding.
 *
 * Everything fails closed: a store failure, or a reply or stored value this module does not recognise, answers 503
 * PERSISTENT_STORE_UNAVAILABLE and grants nothing. Inputs pass the same rules the reader applies before any store
 * command, so nothing is written that a later read would refuse. Redis keeps whatever a script wrote before it failed,
 * so each script checks everything before its first write, and every key a script touches arrives in KEYS. Ids stay
 * decimal strings, in Lua too: GitHub ids reach 2^53, past what Lua numbers and cjson print exactly.
 */

const PREFIX = "vector:cloud-agents:"
// Decision O6: another account cannot take over a binding used, or bound, within the last 30 days.
const TAKEOVER_AFTER_MS = 30 * 86_400_000

// The OIDC verifier's claim patterns (github-oidc.ts), so a binding holds only what a verified bind token can carry.
const Decimal = Schema.String.check(
  Schema.makeFilter((value: string) => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))),
)
const Uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const Repository = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/))
const Login = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/))
const Ref = Schema.String.check(Schema.isPattern(/^refs\/heads\/[^\s:~^?*\[\\]{1,240}$/))
const WorkflowVersion = Schema.String.check(Schema.isPattern(/^[1-9]\d{0,3}$/))
const Visibility = Schema.Literals(["public", "private", "internal"])
const Reason = Schema.Literals(["transferred", "deleted", "binder-left"])
const CODE = /^vbc_[A-Za-z0-9_-]{43}$/

// 2.7: the bind-code JSON, stored under the code's SHA-256 only, and the `binding:<repositoryId>` hash fields.
const StoredCode = Schema.Struct({
  account: Uuid,
  repository: Repository,
  repositoryId: Schema.optionalKey(Decimal),
  githubUserId: Schema.optionalKey(Decimal),
  defaultRef: Schema.optionalKey(Ref),
  exp: Schema.Number.check(Schema.isInt()),
})
const StoredBinding = Schema.Struct({
  repositoryId: Decimal,
  ownerId: Decimal,
  repository: Repository,
  account: Uuid,
  visibility: Visibility,
  defaultRef: Ref,
  generation: Decimal,
  binderGithubId: Decimal,
  binderLogin: Login,
  workflowVersion: WorkflowVersion,
  boundAt: Decimal,
  lastUsedAt: Schema.optionalKey(Decimal),
  suspended: Schema.optionalKey(Reason),
  installationId: Schema.optionalKey(Decimal),
})
const decodeCode = Schema.decodeUnknownOption(Schema.fromJsonString(StoredCode), { onExcessProperty: "error" })
const decodeBinding = Schema.decodeUnknownOption(StoredBinding, { onExcessProperty: "error" })

export type SuspendReason = typeof Reason.Type
export type RepoBinding = {
  repositoryId: string
  ownerId: string
  repository: string
  account: string
  /** From the bind token's repository_visibility; "private" until V08 adds the claim. */
  visibility: "public" | "private" | "internal"
  /** "refs/heads/<default branch>", verified at bind (INV-S11). */
  defaultRef: string
  generation: number
  binder: { githubId: string; login: string }
  workflowVersion: string
  /** Milliseconds since the epoch, like lastUsedAt. */
  boundAt: number
  lastUsedAt?: number
  suspended?: SuspendReason
  /** Verified by the App during bind, never supplied by a client. Absent on legacy or no-App bindings. */
  installationId?: string
}
/** The verified bind-token fields a binding is made from. V08 adds repositoryVisibility to GithubIdentity. */
export type BindIdentity = Pick<
  GithubIdentity,
  "repository" | "repositoryId" | "ownerId" | "actor" | "actorId" | "ref"
> & {
  repositoryVisibility?: "public" | "private" | "internal"
}
export type RedeemInput = {
  code: string
  /** The code's account, as peekBindCode returned it. */
  account: string
  /** The account the repository was bound to when the caller applied O6; absent when it was not bound. */
  current?: string
  identity: BindIdentity
  workflowVersion: string
  installationId?: string
  takeover: { adminVerified: boolean; allowanceInactive: boolean }
  now: number
}

export function bindingKey(repositoryId: string) {
  return `${PREFIX}binding:${repositoryId}`
}

export function generationKey(repositoryId: string) {
  return `${PREFIX}gen:${repositoryId}`
}

export async function createBindCode(
  input: {
    account: string
    repository: string
    repositoryId?: string
    githubUserId?: string
    defaultRef?: string
    now: number
  },
  store = persistentStore,
) {
  if (
    !Schema.is(Uuid)(input.account) ||
    !Schema.is(Repository)(input.repository) ||
    (input.repositoryId !== undefined && !Schema.is(Decimal)(input.repositoryId)) ||
    (input.githubUserId !== undefined && !Schema.is(Decimal)(input.githubUserId)) ||
    (input.defaultRef !== undefined && !Schema.is(Ref)(input.defaultRef)) ||
    !time(input.now)
  )
    throw invalidRequest()
  const code = `vbc_${randomBytes(32).toString("base64url")}`
  const exp = input.now + GithubAgents.BIND_CODE_SECONDS * 1000
  const record = JSON.stringify({
    account: input.account,
    repository: input.repository,
    ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
    ...(input.githubUserId === undefined ? {} : { githubUserId: input.githubUserId }),
    ...(input.defaultRef === undefined ? {} : { defaultRef: input.defaultRef }),
    exp,
  })
  const reply = await store([
    "EVAL",
    ISSUE_CODE,
    "2",
    codeKey(code),
    `vector:cli-revoked:${input.account}`,
    record,
    GithubAgents.BIND_CODE_SECONDS,
  ])
  if (reply === "revoked") throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
  if (reply !== "OK") throw storeUnavailable()
  return { code, expiresAt: exp }
}

const ISSUE_CODE = `
if redis.call('GET', KEYS[2]) then return 'revoked' end
return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
`

/** Every refusal is the same 403, whatever its cause, and nothing is consumed. */
export async function peekBindCode(code: string, identity: BindIdentity, now = Date.now(), store = persistentStore) {
  if (typeof code !== "string" || !CODE.test(code)) throw bindCodeInvalid()
  const reply = await store(["GET", codeKey(code)])
  if (reply === null) throw bindCodeInvalid()
  const record = typeof reply === "string" ? Option.getOrUndefined(decodeCode(reply)) : undefined
  if (!record) throw storeUnavailable()
  // REDEEM repeats these checks in Lua; the tests run one table of cases through both.
  if (
    record.exp <= now ||
    record.repository.toLowerCase() !== identity.repository.toLowerCase() ||
    (record.repositoryId !== undefined && record.repositoryId !== identity.repositoryId) ||
    (record.githubUserId !== undefined && record.githubUserId !== identity.actorId)
  )
    throw bindCodeInvalid()
  return { account: record.account, ...(record.defaultRef === undefined ? {} : { defaultRef: record.defaultRef }) }
}

/** The O6 rule REDEEM applies, for the bind API's read-only check before it consumes anything. */
export function takeoverAllowed(
  current: RepoBinding | undefined,
  input: {
    account: string
    ownerId: string
    takeover: { adminVerified: boolean; allowanceInactive: boolean }
    now: number
  },
) {
  if (!current || current.account === input.account) return true
  return (
    current.suspended !== undefined ||
    current.ownerId !== input.ownerId ||
    input.takeover.adminVerified ||
    input.takeover.allowanceInactive ||
    input.now - Math.max(current.lastUsedAt ?? 0, current.boundAt) >= TAKEOVER_AFTER_MS
  )
}

/**
 * Consumes the code and writes the binding in one EVAL, so a refusal never burns the code and two parallel binds
 * yield one binding. The caller must have verified identity.ref as the repository's default branch (INV-S11).
 * `changed` means the repository's binder is no longer the `current` the caller judged.
 */
export async function recordRepoBinding(input: RedeemInput, store = persistentStore) {
  const identity = input.identity
  const visibility = identity.repositoryVisibility ?? "private"
  if (
    !Schema.is(Uuid)(input.account) ||
    (input.current !== undefined && !Schema.is(Uuid)(input.current)) ||
    !Schema.is(Repository)(identity.repository) ||
    !Schema.is(Decimal)(identity.repositoryId) ||
    !Schema.is(Decimal)(identity.ownerId) ||
    !Schema.is(Login)(identity.actor) ||
    !Schema.is(Decimal)(identity.actorId) ||
    !Schema.is(Ref)(identity.ref) ||
    !Schema.is(Visibility)(visibility) ||
    !Schema.is(WorkflowVersion)(input.workflowVersion) ||
    (input.installationId !== undefined && !Schema.is(Decimal)(input.installationId)) ||
    typeof input.takeover.adminVerified !== "boolean" ||
    typeof input.takeover.allowanceInactive !== "boolean" ||
    !time(input.now)
  )
    throw invalidRequest()
  if (typeof input.code !== "string" || !CODE.test(input.code)) return { ok: false as const, refusal: "code" as const }
  const reply = await store([
    "EVAL",
    REDEEM,
    "7",
    codeKey(input.code),
    bindingKey(identity.repositoryId),
    generationKey(identity.repositoryId),
    accountKey(input.account),
    accountKey(input.current ?? input.account),
    binderLeftKey(input.account),
    `vector:cli-revoked:${input.account}`,
    String(input.now),
    input.account,
    input.current ?? "",
    identity.repository,
    identity.repositoryId,
    identity.ownerId,
    identity.actor,
    identity.actorId,
    identity.ref,
    visibility,
    input.workflowVersion,
    input.takeover.adminVerified ? "1" : "0",
    input.takeover.allowanceInactive ? "1" : "0",
    String(TAKEOVER_AFTER_MS),
    input.installationId ?? "",
  ])
  if (reply === "code" || reply === "elsewhere" || reply === "changed") return { ok: false as const, refusal: reply }
  if (!Array.isArray(reply) || reply.length !== 2 || reply[0] !== "ok" || !Schema.is(Decimal)(reply[1]))
    throw storeUnavailable()
  const binding: RepoBinding = {
    repositoryId: identity.repositoryId,
    ownerId: identity.ownerId,
    repository: identity.repository,
    account: input.account,
    visibility,
    defaultRef: identity.ref,
    generation: Number(reply[1]),
    binder: { githubId: identity.actorId, login: identity.actor },
    workflowVersion: input.workflowVersion,
    boundAt: input.now,
    ...(input.installationId === undefined ? {} : { installationId: input.installationId }),
  }
  return { ok: true as const, binding }
}

export async function redeemAndBind(input: RedeemInput, store = persistentStore) {
  const result = await recordRepoBinding(input, store)
  if (result.ok) return result.binding
  if (result.refusal === "code") throw bindCodeInvalid()
  throw new ApiError(409, "REPO_BOUND_ELSEWHERE", "This repository is connected to another Vector account.")
}

export async function bindingFor(repositoryId: string, store = persistentStore) {
  if (!Schema.is(Decimal)(repositoryId)) throw invalidRequest()
  const reply = await store(["EVAL", READ, "1", bindingKey(repositoryId)])
  if (!Array.isArray(reply) || reply.length !== 1) throw storeUnavailable()
  return storedBinding(reply[0], repositoryId)
}

/** The account's own bindings, newest first. Set members whose binding is gone or another account's are skipped. */
export async function bindingsForAccount(account: string, store = persistentStore) {
  if (!Schema.is(Uuid)(account)) throw invalidRequest()
  const members = await store(["EVAL", MEMBERS, "1", accountKey(account)])
  if (!Array.isArray(members) || !members.every(Schema.is(Decimal))) throw storeUnavailable()
  if (!members.length) return []
  // A second read: each binding's key is declared, which the set's own script could not do.
  const replies = await store(["EVAL", READ, String(members.length), ...members.map(bindingKey)])
  if (!Array.isArray(replies) || replies.length !== members.length) throw storeUnavailable()
  return members
    .flatMap((repositoryId: string, index) => {
      const binding = storedBinding(replies[index], repositoryId)
      return binding?.account === account ? [binding] : []
    })
    .sort((a, b) => b.boundAt - a.boundAt || Number(a.repositoryId) - Number(b.repositoryId))
}

/** Only the displayed binding's account and exact generation may unbind. A later rebind must survive stale consent. */
export async function revokeBinding(
  repositoryId: string,
  account: string,
  expectedGeneration: number,
  store = persistentStore,
) {
  if (!Schema.is(Decimal)(repositoryId) || !Schema.is(Uuid)(account) || !time(expectedGeneration))
    throw invalidRequest()
  const reply = await store([
    "EVAL",
    REVOKE,
    "3",
    bindingKey(repositoryId),
    generationKey(repositoryId),
    accountKey(account),
    account,
    repositoryId,
    String(expectedGeneration),
  ])
  if (reply !== 0 && reply !== 1) throw storeUnavailable()
  return reply === 1
}

/** Records a use; lastUsedAt never moves back, and a removed binding is never recreated. */
export async function touchBinding(repositoryId: string, now: number, store = persistentStore) {
  if (!Schema.is(Decimal)(repositoryId) || !time(now)) throw invalidRequest()
  const reply = await store(["EVAL", TOUCH, "1", bindingKey(repositoryId), String(now)])
  if (reply !== 0 && reply !== 1) throw storeUnavailable()
}

/**
 * Suspends the binding the caller read, and only that one: once the repository has been rebound, taken over or
 * unbound, the binding and the generation are left alone, so a decision made against one binding never lands on the
 * next. The first suspension moves the generation, so the binding's live run tokens die; later calls never do. The
 * first reason is kept, except that binder-left replaces any other and is never replaced, because it hides the
 * repository's detail from the former binder (INV-P3). Binder-left also adds the repository to the read account's
 * binder-left set, which outlives the binding, so an unbind or a takeover cannot show that detail again; it does so
 * even when the binding read is gone or another account's has replaced it, as it would have had it landed first, and
 * skips it only while the account holds the repository again. Unknown repositories are a no-op.
 */
export async function suspendBinding(
  binding: Pick<RepoBinding, "repositoryId" | "generation" | "account">,
  reason: SuspendReason,
  store = persistentStore,
) {
  if (
    !Schema.is(Decimal)(binding.repositoryId) ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1 ||
    !Schema.is(Uuid)(binding.account) ||
    !Schema.is(Reason)(reason)
  )
    throw invalidRequest()
  const reply = await store([
    "EVAL",
    SUSPEND,
    "4",
    bindingKey(binding.repositoryId),
    generationKey(binding.repositoryId),
    binderLeftKey(binding.account),
    `vector:cli-revoked:${binding.account}`,
    reason,
    String(binding.generation),
    binding.account,
    binding.repositoryId,
  ])
  if (
    reply !== "missing" &&
    reply !== "stale" &&
    reply !== "recorded" &&
    reply !== "kept" &&
    reply !== "replaced" &&
    reply !== "suspended"
  )
    throw storeUnavailable()
}

/** Unknown repositories are a no-op. */
export async function renameBinding(repositoryId: string, repository: string, store = persistentStore) {
  if (!Schema.is(Decimal)(repositoryId) || !Schema.is(Repository)(repository)) throw invalidRequest()
  const reply = await store(["EVAL", RENAME, "1", bindingKey(repositoryId), repository])
  if (reply !== 0 && reply !== 1) throw storeUnavailable()
}

// The reader's rules for the stored fields the scripts decide on (decimal ids and times, accounts, the suspension
// reasons), so a malformed value is never read as grounds for a takeover or a suspension. Prepended to the scripts
// that need them.
const STORED_RULES = `
local function decimal(value)
  return type(value) == 'string' and string.match(value, '^[1-9]%d*$') ~= nil and tonumber(value) <= 9007199254740991
end
local hex = '[0-9a-f]'
local uuidPattern = '^' .. string.rep(hex, 8) .. '%-' .. string.rep(hex, 4) .. '%-' .. string.rep(hex, 4) .. '%-'
  .. string.rep(hex, 4) .. '%-' .. string.rep(hex, 12) .. '$'
local function uuid(value)
  return type(value) == 'string' and string.match(value, uuidPattern) ~= nil
end
local reasons = { transferred = true, deleted = true, ['binder-left'] = true }
`

// KEYS: the code, the binding, the generation, the code account's set, the set of the account the caller judged
// (the code account's own set when there was none), the code account's binder-left set, its revocation key. ARGV: now, account, judged
// account or "", repository, repository id, owner id, actor, actor id, ref, visibility, workflow version, admin
// verified, allowance inactive, O6 window.
const REDEEM = `${STORED_RULES}
if redis.call('GET', KEYS[7]) then return 'code' end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'code' end
local decoded, code = pcall(cjson.decode, raw)
if not decoded or type(code) ~= 'table' or type(code.account) ~= 'string' or type(code.repository) ~= 'string'
  or type(code.exp) ~= 'number' or (code.repositoryId ~= nil and type(code.repositoryId) ~= 'string')
  or (code.githubUserId ~= nil and type(code.githubUserId) ~= 'string') then return 'corrupt' end
local now = tonumber(ARGV[1])
if code.account ~= ARGV[2] or code.exp <= now or string.lower(code.repository) ~= string.lower(ARGV[4])
  or (code.repositoryId ~= nil and code.repositoryId ~= ARGV[5])
  or (code.githubUserId ~= nil and code.githubUserId ~= ARGV[8]) then return 'code' end
local fields = redis.call('HGETALL', KEYS[2])
local binding = {}
for i = 1, #fields, 2 do binding[fields[i]] = fields[i + 1] end
local previous = binding.account
if #fields > 0 and not previous then return 'corrupt' end
if previous and previous ~= ARGV[2] then
  if previous ~= ARGV[3] then return 'changed' end
  if not decimal(binding.ownerId) or not decimal(binding.boundAt)
    or (binding.lastUsedAt ~= nil and not decimal(binding.lastUsedAt))
    or (binding.suspended ~= nil and not reasons[binding.suspended]) then return 'corrupt' end
  local lastUse = math.max(tonumber(binding.lastUsedAt or '0'), tonumber(binding.boundAt))
  if not (binding.suspended or binding.ownerId ~= ARGV[6] or ARGV[12] == '1' or ARGV[13] == '1'
    or now - lastUse >= tonumber(ARGV[14])) then return 'elsewhere' end
end
for _, key in ipairs({ KEYS[4], KEYS[5], KEYS[6] }) do
  local kind = redis.call('TYPE', key).ok
  if kind ~= 'set' and kind ~= 'none' then return 'corrupt' end
end
local generation = redis.call('INCR', KEYS[3])
redis.call('DEL', KEYS[1], KEYS[2])
if previous and previous ~= ARGV[2] then redis.call('SREM', KEYS[5], ARGV[5]) end
redis.call('HSET', KEYS[2], 'repositoryId', ARGV[5], 'ownerId', ARGV[6], 'repository', ARGV[4], 'account', ARGV[2],
  'visibility', ARGV[10], 'defaultRef', ARGV[9], 'generation', tostring(generation), 'binderGithubId', ARGV[8],
  'binderLogin', ARGV[7], 'workflowVersion', ARGV[11], 'boundAt', ARGV[1])
if ARGV[15] ~= '' then redis.call('HSET', KEYS[2], 'installationId', ARGV[15]) end
redis.call('SADD', KEYS[4], ARGV[5])
-- The account's own new binding has a binder with write access again.
redis.call('SREM', KEYS[6], ARGV[5])
return { 'ok', tostring(generation) }
`

// HGETALL inside a script, so the reply is a flat array on every protocol (a RESP3 client gets a map otherwise).
const READ = `
local replies = {}
for i, key in ipairs(KEYS) do replies[i] = redis.call('HGETALL', key) end
return replies
`

const MEMBERS = `return redis.call('SMEMBERS', KEYS[1])`

// KEYS: the binding, the generation, the account's set. ARGV: account, repository id, displayed generation.
const REVOKE = `${STORED_RULES}
if redis.call('HGET', KEYS[1], 'account') ~= ARGV[1] then return 0 end
local generation = redis.call('HGET', KEYS[1], 'generation')
if not decimal(generation) then return 'corrupt' end
if generation ~= ARGV[3] then return 0 end
local counter = redis.call('GET', KEYS[2])
if not decimal(counter) or counter ~= generation or tonumber(counter) >= 9007199254740991 then return 'corrupt' end
local kind = redis.call('TYPE', KEYS[3]).ok
if kind ~= 'set' and kind ~= 'none' then return 'corrupt' end
redis.call('INCR', KEYS[2])
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[3], ARGV[2])
return 1
`

const TOUCH = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local last = tonumber(redis.call('HGET', KEYS[1], 'lastUsedAt') or '0')
if not last then return 'corrupt' end
if tonumber(ARGV[1]) > last then redis.call('HSET', KEYS[1], 'lastUsedAt', ARGV[1]) end
return 1
`

// KEYS: the binding, the generation, the read account's binder-left set, its revocation key. ARGV: the reason, and the generation,
// account and repository id of the binding the caller read. That binding keeps its generation until its own first
// suspension moves it by one; every rebind, takeover, unbind or bind after an unbind moves it too and clears the
// suspension, so a stored binding that is neither, or that names another account, is a later one, and it and the
// counter are left alone. Binder-left is the read account's fact, not the binding's, so it still goes into that
// account's set once the binding read is gone (the counter passed it) or another account's later binding holds the
// repository: the set then ends as if this script had run first. Only a later binding of the account's own skips it;
// its binder had write access when it bound, and its bind clears the member anyway.
const SUSPEND = `${STORED_RULES}
if redis.call('GET', KEYS[4]) then return 'stale' end
local expected = tonumber(ARGV[2])
-- On these two late paths the SADD is the only write, so a set of another type fails the script with nothing written.
if redis.call('EXISTS', KEYS[1]) == 0 then
  if ARGV[1] ~= 'binder-left' then return 'missing' end
  local counter = redis.call('GET', KEYS[2])
  if not counter then return 'missing' end
  if not decimal(counter) then return 'corrupt' end
  -- Removing the binding read moved the counter past its generation; a counter short of that names no such binding.
  if tonumber(counter) <= expected then return 'missing' end
  redis.call('SADD', KEYS[3], ARGV[4])
  return 'recorded'
end
local stored = redis.call('HGET', KEYS[1], 'generation')
if not decimal(stored) then return 'corrupt' end
local current = redis.call('HGET', KEYS[1], 'suspended')
if current and not reasons[current] then return 'corrupt' end
local account = redis.call('HGET', KEYS[1], 'account')
if not uuid(account) then return 'corrupt' end
local generation = tonumber(stored)
if account ~= ARGV[3] then
  -- Another account's binding replaced the one read only if it was bound after it; a suspended binding was bound one
  -- generation before the one it holds.
  if ARGV[1] ~= 'binder-left' or generation - (current and 1 or 0) <= expected then return 'stale' end
  redis.call('SADD', KEYS[3], ARGV[4])
  return 'recorded'
end
if generation ~= expected and not (current and generation == expected + 1) then return 'stale' end
if current == 'binder-left' or (current and ARGV[1] ~= 'binder-left') then return 'kept' end
if ARGV[1] == 'binder-left' then
  local kind = redis.call('TYPE', KEYS[3]).ok
  if kind ~= 'set' and kind ~= 'none' then return 'corrupt' end
end
-- INCR before any other write, so a corrupt counter fails the script with nothing written.
local moved = current and stored or tostring(redis.call('INCR', KEYS[2]))
if ARGV[1] == 'binder-left' then redis.call('SADD', KEYS[3], ARGV[4]) end
redis.call('HSET', KEYS[1], 'suspended', ARGV[1], 'generation', moved)
return current and 'replaced' or 'suspended'
`

const RENAME = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'repository', ARGV[1])
return 1
`

function storedBinding(reply: unknown, repositoryId: string): RepoBinding | undefined {
  if (!Array.isArray(reply) || reply.length % 2 || !reply.every((item) => typeof item === "string"))
    throw storeUnavailable()
  if (!reply.length) return undefined
  const fields = Object.fromEntries(
    Array.from({ length: reply.length / 2 }, (_, i) => [reply[2 * i], reply[2 * i + 1]]),
  )
  const stored = Option.getOrUndefined(decodeBinding(fields))
  if (!stored || stored.repositoryId !== repositoryId) throw storeUnavailable()
  return {
    repositoryId: stored.repositoryId,
    ownerId: stored.ownerId,
    repository: stored.repository,
    account: stored.account,
    visibility: stored.visibility,
    defaultRef: stored.defaultRef,
    generation: Number(stored.generation),
    binder: { githubId: stored.binderGithubId, login: stored.binderLogin },
    workflowVersion: stored.workflowVersion,
    boundAt: Number(stored.boundAt),
    ...(stored.installationId === undefined ? {} : { installationId: stored.installationId }),
    ...(stored.lastUsedAt === undefined ? {} : { lastUsedAt: Number(stored.lastUsedAt) }),
    ...(stored.suspended === undefined ? {} : { suspended: stored.suspended }),
  }
}

function accountKey(account: string) {
  return `${PREFIX}bindings:${account}`
}

// The repositories whose binder lost access while bound to the account. It outlives their bindings, because the
// account's run records do (2.18), and a new bind of the repository by the account itself removes it.
function binderLeftKey(account: string) {
  return `${PREFIX}binder-left:${account}`
}

// Only the code's SHA-256 is ever stored: the code itself is shown once and never written anywhere.
function codeKey(code: string) {
  return `${PREFIX}bind-code:${createHash("sha256").update(code).digest("hex")}`
}

function time(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function invalidRequest() {
  return new ApiError(400, "INVALID_REQUEST", "Send only the supported repository binding fields.")
}

function bindCodeInvalid() {
  return new ApiError(403, "BIND_CODE_INVALID", "This bind code is invalid, expired or already used. Get a new one.")
}

function storeUnavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected GitHub services are temporarily unavailable.")
}
