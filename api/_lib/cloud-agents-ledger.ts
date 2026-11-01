import { Option, Schema } from "effect"
import { GithubAgents } from "../../packages/core/src/github-agents.js"
import { bindingKey, generationKey } from "./cloud-agents-binding.js"
import { RUN_SOURCES, type CloudAgentAllowance, type RunSource, type RunTrigger } from "./cloud-agents-entitlement.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Hours, slots and scheduled runs for @vector (vector-at-mention-spec 2.6 and 2.7, V06). V12's mint reserves a run with
 * reserveRun and releases it with releaseRun when the mint fails afterwards; its heartbeat and settle routes call
 * reportRun and settleRun; Codium's gateway calls recordCodiumRequest through cloudAgentsGatewayHook (registered in
 * A59) and reads cloudAgentSecondsUsed for the status meter (A18); V07's run-token check reads live runs through
 * liveKey.
 *
 * Reservations are charged up front. A fresh reserve adds the whole reservation to used:<account>:<epoch>, and every
 * settle path (explicit, idle, a generation change) gives back the part the one formula does not charge:
 * clamp(max(lastRequest ?? 0, lastReport) - startedAt, 0, deadline - startedAt), rounded up to whole seconds. No script
 * ever needs the used key of an epoch it cannot name before it runs: a settle gives back only into the epoch its caller
 * names, and a run of another epoch that a reserve removes to free its slot (idle, or replaced after a generation
 * change) keeps its whole reservation in that epoch. The live hash outlives every used key its runs are charged to, so a
 * run nobody settles (a cancelled job, a lost runner, a token a rebind, an unbind or a suspension killed) is still
 * charged by the formula: once idle, the next reserve or agent-time read of its epoch settles it before reading used.
 *
 * Every function is one EVAL that gets every key it touches in KEYS, and everything fails closed: a store failure, or a
 * reply or stored value this module does not recognise, answers 503 PERSISTENT_STORE_UNAVAILABLE and grants nothing.
 * Inputs pass the reader's rules before any store command (400 INVALID_REQUEST). Redis keeps whatever a script wrote
 * before it failed, so each script reads and checks everything first. Times are written with %.0f and numbers come
 * back as decimal strings, because Lua's tostring keeps only 14 significant digits. Expiries are durations from the
 * caller's clock, so the API host's clock and the store's never have to agree.
 */

const PREFIX = "vector:cloud-agents:"
const DAY_MS = 86_400_000
// 2.7: agent time is kept for the period plus 40 days, scheduled counts for 2 days, and live runs at least as long as
// the agent time they are charged to and their deadline plus a day.
const USED_KEPT_MS = 40 * DAY_MS
const SCHEDULED_KEPT_MS = 2 * DAY_MS
const LIVE_KEPT_MS = DAY_MS
// The latest time a Date can hold, so every time names a UTC day.
const LATEST_TIME = 8_640_000_000_000_000

/** A meter epoch: the local `p<periodStart>`, or Codium's `<subscription>:<periodStart>` (and its `none`). */
export const METER_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/

const Decimal = Schema.String.check(
  Schema.makeFilter((value: string) => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))),
)
const Uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const RunId = Schema.String.check(Schema.isPattern(GithubAgents.RUN_ID_PATTERN))
const Thread = Schema.String.check(Schema.isPattern(GithubAgents.THREAD_PATTERN))
const Epoch = Schema.String.check(Schema.isPattern(METER_EPOCH_PATTERN))
// 16 random bytes in base64url (2.4).
const Jti = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/))
const Source = Schema.Literals(["github-comment", "github-dispatch", "github-schedule"])
const Purpose = Schema.Literals(["task", "review", "scheduled"])
const TriggerSource = Schema.Literals(RUN_SOURCES)
const TriggerPurpose = Schema.Literals(["task", "review", "incident", "changes"])
const Time = Schema.Number.check(
  Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value > 0 && value <= LATEST_TIME),
)
// A stored time may pass LATEST_TIME by one run's length.
const StoredTime = Schema.Number.check(Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value > 0))
const Generation = Schema.Number.check(Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value >= 1))
// Only the one-time ticket key (2.7) can be consumed, so no caller can delete an arbitrary key.
const TICKET_KEY = /^vector:cloud-agents:ticket:[0-9a-f]{64}$/

// 2.7's live record. The relations are what the charge arithmetic needs: a whole number of seconds reserved, and
// activity no earlier than the start. The scripts' own decoder applies the same rules.
const StoredRun = Schema.Struct({
  startedAt: StoredTime,
  deadline: StoredTime,
  lastReport: StoredTime,
  lastRequest: Schema.optionalKey(StoredTime),
  epoch: Epoch,
  repo: Decimal,
  thr: Thread,
  src: Source,
  pur: Purpose,
  counted: Schema.optionalKey(Schema.Literal(true)),
  gen: Generation,
  jti: Jti,
  triggerSource: Schema.optionalKey(TriggerSource),
  triggerPurpose: Schema.optionalKey(TriggerPurpose),
}).check(
  Schema.makeFilter(
    (run: {
      startedAt: number
      deadline: number
      lastReport: number
      lastRequest?: number
      src: string
      counted?: true
      pur: string
      triggerSource?: string
      triggerPurpose?: string
    }) =>
      run.deadline > run.startedAt &&
      (run.deadline - run.startedAt) % 1000 === 0 &&
      run.lastReport >= run.startedAt &&
      (run.lastRequest === undefined || run.lastRequest >= run.startedAt) &&
      (run.counted === undefined || run.src === "github-schedule") &&
      ((run.triggerSource === undefined && run.triggerPurpose === undefined) ||
        (run.triggerSource !== undefined &&
          run.triggerPurpose !== undefined &&
          run.src === "github-dispatch" &&
          run.pur === (run.triggerPurpose === "review" ? "review" : "task"))),
  ),
)
const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(StoredRun), { onExcessProperty: "error" })
// Replies: seconds may be 0, and a reservation comes back as the record's values.
const Whole = Schema.String.check(
  Schema.makeFilter((value: string) => /^(?:0|[1-9]\d{0,15})$/.test(value) && Number.isSafeInteger(Number(value))),
)
const decodeReserved = Schema.decodeUnknownOption(
  Schema.Tuple([
    Schema.Literal("ok"),
    Decimal,
    Decimal,
    Schema.Literals(["0", "1"]),
    Epoch,
    Thread,
    Source,
    Purpose,
    Schema.Literals(["", ...RUN_SOURCES]),
    Schema.Literals(["", "task", "review", "incident", "changes"]),
  ]),
)

export type LedgerSource = Extract<RunSource, "github-comment" | "github-dispatch" | "github-schedule">
export type LedgerPurpose = "task" | "review" | "scheduled"
/** One live run in `live:<account>`, keyed by its rid. Times are milliseconds since the epoch. */
export type LiveRun = {
  startedAt: number
  deadline: number
  lastReport: number
  lastRequest?: number
  epoch: string
  repo: string
  thr: string
  src: LedgerSource
  pur: LedgerPurpose
  /** Present when this record's reserve counted a scheduled run on its start's UTC day, which a release uncounts. */
  counted?: true
  gen: number
  jti: string
  triggerSource?: RunSource
  triggerPurpose?: Exclude<RunTrigger["purpose"], "scheduled">
}
export type ReserveInput = {
  account: string
  rid: string
  repositoryId: string
  thread: string
  generation: number
  /** The new token's jti. */
  jti: string
  source: LedgerSource
  purpose: LedgerPurpose
  allowance: Extract<CloudAgentAllowance, { active: true }>
  /**
   * The one-time ticket key, deleted only when the reservation succeeds. A fresh reservation also needs it to still
   * exist, so of the mints that peeked one ticket only one reserves; a renewal of that check run needs no ticket.
   */
  consumeKey?: string
  trigger?: { source: RunSource; purpose: Exclude<RunTrigger["purpose"], "scheduled"> }
  /** An exact, previously observed ticket-authorized live run; never grants a fresh reservation. */
  renewalJti?: string
  now: number
}
/** What the token must sign: the live record's values, which a renewal keeps whatever the new mint asked for. */
type Reserved = {
  startedAt: number
  deadline: number
  epoch: string
  thread: string
  source: LedgerSource
  purpose: LedgerPurpose
  trigger?: ReserveInput["trigger"]
}
export type ReserveResult =
  | ({ ok: true; renewed: false } & Reserved)
  | ({ ok: true; renewed: true } & Reserved)
  | { ok: false; limit: "hours" | "at-once" | "scheduled" }
  /** The ticket is gone: another check run's reservation consumed it, or it expired, after the mint peeked it. */
  | { ok: false; refusal: "ticket" }

export function liveKey(account: string) {
  return `${PREFIX}live:${account}`
}

export function usedKey(account: string, epoch: string) {
  return `${PREFIX}used:${account}:${epoch}`
}

/** Shared with run history and settlement verification; no account identity is encoded in this key. */
export function runRecordKey(rid: string) {
  return `${PREFIX}run:${rid}`
}

/**
 * Settles the account's idle runs, then renews the rid's live reservation in place (same generation, before its
 * deadline: new jti, same start and deadline, no checks, no charge) or checks the ticket, runs at once, scheduled runs
 * today and hours left, in that order, and reserves `min(longest run, left)`. A lower generation than the live
 * record's, or a deadline already passed, leaves that record alone and answers `at-once`.
 */
export async function reserveRun(input: ReserveInput, store = persistentStore): Promise<ReserveResult> {
  return reserve(input, store, false)
}

/** HTTP admission always checks the stored binding in the reservation's atomic write. */
export async function reserveBoundRun(input: ReserveInput, store = persistentStore): Promise<ReserveResult> {
  return reserve(input, store, true)
}

async function reserve(input: ReserveInput, store: typeof persistentStore, bound: boolean): Promise<ReserveResult> {
  const allowance = input.allowance
  if (!validReserve(input)) throw invalidRequest()
  if (
    bound &&
    ((input.consumeKey !== undefined && !input.trigger) || (input.trigger && !input.consumeKey && !input.renewalJti))
  )
    throw invalidRequest()
  const reply = await store([
    "EVAL",
    RESERVE,
    String(4 + (bound ? 2 : 0) + (input.consumeKey === undefined ? 0 : 1)),
    liveKey(input.account),
    usedKey(input.account, allowance.meterEpoch),
    scheduledKey(input.account, input.now),
    `vector:cli-revoked:${input.account}`,
    ...(bound ? [bindingKey(input.repositoryId), generationKey(input.repositoryId)] : []),
    ...(input.consumeKey === undefined ? [] : [input.consumeKey]),
    String(input.now),
    input.rid,
    allowance.meterEpoch,
    input.repositoryId,
    input.thread,
    input.source,
    input.purpose,
    String(input.generation),
    input.jti,
    String(allowance.limits.atOnce),
    String(allowance.limits.longestRunMin * 60),
    String(allowance.limits.scheduledPerDay),
    String(allowance.allowanceSeconds),
    String(Math.max(allowance.periodEnd - input.now, 0) + USED_KEPT_MS),
    input.account,
    bound ? "1" : "0",
    input.trigger?.source ?? "",
    input.trigger?.purpose ?? "",
    input.renewalJti ?? "",
  ])
  if (reply === "revoked") throw new ApiError(404, "REPO_NOT_BOUND", "This repository is not connected.")
  if (reply === "binding") throw new ApiError(409, "BINDING_SUSPENDED", "Connect this repository again.")
  if (reply === "hours" || reply === "at-once" || reply === "scheduled") return { ok: false, limit: reply }
  if (reply === "ticket") return { ok: false, refusal: "ticket" }
  const reserved = Option.getOrUndefined(decodeReserved(reply))
  if (!reserved) throw storeUnavailable()
  if (
    (reserved[8] === "") !== (reserved[9] === "") ||
    (reserved[8] !== "" &&
      (reserved[6] !== "github-dispatch" || reserved[7] !== (reserved[9] === "review" ? "review" : "task")))
  )
    throw storeUnavailable()
  const result = {
    startedAt: Number(reserved[1]),
    deadline: Number(reserved[2]),
    epoch: reserved[4],
    thread: reserved[5],
    source: reserved[6],
    purpose: reserved[7],
    ...(reserved[8] !== "" && reserved[9] !== "" ? { trigger: { source: reserved[8], purpose: reserved[9] } } : {}),
  }
  return reserved[3] === "1" ? { ok: true, renewed: true, ...result } : { ok: true, renewed: false, ...result }
}

/** A heartbeat from the token that holds the run; any other token, or a settled run, is not live. */
export async function reportRun(
  account: string,
  rid: string,
  token: { jti: string },
  now: number,
  store = persistentStore,
) {
  if (!Schema.is(Uuid)(account) || !Schema.is(RunId)(rid) || !Schema.is(Jti)(token.jti) || !Schema.is(Time)(now))
    throw invalidRequest()
  const reply = await store(["EVAL", REPORT, "1", liveKey(account), rid, token.jti, String(now)])
  if (Array.isArray(reply) && reply.length === 1 && reply[0] === "0") return { live: false as const }
  if (Array.isArray(reply) && reply.length === 2 && reply[0] === "1" && Schema.is(Decimal)(reply[1]))
    return { live: true as const, deadline: Number(reply[1]) }
  throw storeUnavailable()
}

/** A Codium request of the run ended at `at`. A settled or unknown run is left alone, and nothing is created. */
export async function recordCodiumRequest(account: string, rid: string, at: number, store = persistentStore) {
  if (!Schema.is(Uuid)(account) || !Schema.is(RunId)(rid) || !Schema.is(Time)(at)) throw invalidRequest()
  const reply = await store(["EVAL", RECORD, "1", liveKey(account), rid, String(at)])
  if (reply !== "missing" && reply !== "kept" && reply !== "recorded") throw storeUnavailable()
}

/**
 * Ends the run that `token` holds and charges it by the one formula; `seconds` is what the run stays charged. The
 * unused reservation goes back only into the token's epoch, which is the record's unless the caller is wrong, and then
 * the whole reservation stays charged. Idempotent: a settled run, or another token, settles nothing.
 */
export async function settleRun(
  account: string,
  rid: string,
  token: { jti: string; epoch: string },
  store = persistentStore,
) {
  if (
    !Schema.is(Uuid)(account) ||
    !Schema.is(RunId)(rid) ||
    !Schema.is(Jti)(token.jti) ||
    !Schema.is(Epoch)(token.epoch)
  )
    throw invalidRequest()
  const reply = await store([
    "EVAL",
    SETTLE,
    "2",
    liveKey(account),
    usedKey(account, token.epoch),
    rid,
    token.jti,
    token.epoch,
  ])
  if (Array.isArray(reply) && reply.length === 2 && reply[0] === "0" && reply[1] === "0")
    return { settled: false, seconds: 0 }
  const charged = Array.isArray(reply) && reply.length === 2 && reply[0] === "1" ? seconds(reply[1]) : undefined
  if (charged === undefined) throw storeUnavailable()
  return { settled: true, seconds: charged }
}

/** HTTP settlement commits the first outcome and the charge together; retries keep that exact outcome. */
export async function settleRecordedRun(
  account: string,
  rid: string,
  token: { jti: string; epoch: string; repo: string; gen: number },
  input: { outcome: GithubAgents.Outcome; now: number },
  store = persistentStore,
): Promise<{ outcome: GithubAgents.Outcome }> {
  if (
    !Schema.is(Uuid)(account) ||
    !Schema.is(RunId)(rid) ||
    !Schema.is(Jti)(token.jti) ||
    !Schema.is(Epoch)(token.epoch) ||
    !Schema.is(Decimal)(token.repo) ||
    !Schema.is(Generation)(token.gen) ||
    !Schema.is(Time)(input.now) ||
    !GithubAgents.OUTCOME.includes(input.outcome)
  )
    throw invalidRequest()
  const reply = await store([
    "EVAL",
    SETTLE_RECORDED,
    "6",
    liveKey(account),
    usedKey(account, token.epoch),
    runRecordKey(rid),
    `vector:cli-revoked:${account}`,
    bindingKey(token.repo),
    generationKey(token.repo),
    rid,
    token.jti,
    token.epoch,
    account,
    String(token.gen),
    String(input.now),
    input.outcome,
    input.outcome === "changes" ? "pass" : input.outcome === "draft" || input.outcome === "failed" ? "fail" : "none",
  ])
  if (reply === "stale") throw new ApiError(401, "MODEL_PLAN_RUN_EXPIRED", "This run is no longer authorized.")
  if (typeof reply !== "string" || !GithubAgents.OUTCOME.includes(reply as GithubAgents.Outcome))
    throw storeUnavailable()
  return { outcome: reply as GithubAgents.Outcome }
}

/**
 * Undoes a fresh reservation when the mint fails after it, charging nothing: it gives back the whole reservation and,
 * when it counted one, the scheduled run on its start's UTC day. A renewal is never released (its type cannot be
 * passed), and a reservation that another mint has since renewed or replaced is left alone.
 */
export async function releaseRun(
  account: string,
  rid: string,
  reservation: { renewed: false; jti: string; epoch: string; startedAt: number },
  store = persistentStore,
) {
  if (
    !Schema.is(Uuid)(account) ||
    !Schema.is(RunId)(rid) ||
    reservation.renewed !== false ||
    !Schema.is(Jti)(reservation.jti) ||
    !Schema.is(Epoch)(reservation.epoch) ||
    !Schema.is(Time)(reservation.startedAt)
  )
    throw invalidRequest()
  const reply = await store([
    "EVAL",
    RELEASE,
    "3",
    liveKey(account),
    usedKey(account, reservation.epoch),
    scheduledKey(account, reservation.startedAt),
    rid,
    reservation.jti,
    reservation.epoch,
    String(reservation.startedAt),
  ])
  if (reply !== "kept" && reply !== "released") throw storeUnavailable()
}

/**
 * Seconds charged to settled runs of the epoch, after settling its idle runs. Live runs' reservations are not counted,
 * and idle runs of other epochs are left for the reserve that needs their slot.
 */
export async function cloudAgentSecondsUsed(
  accountId: string,
  meterEpoch: string,
  now = Date.now(),
  store = persistentStore,
) {
  if (!Schema.is(Uuid)(accountId) || !Schema.is(Epoch)(meterEpoch) || !Schema.is(Time)(now)) throw invalidRequest()
  const reply = await store([
    "EVAL",
    USED,
    "2",
    liveKey(accountId),
    usedKey(accountId, meterEpoch),
    meterEpoch,
    String(now),
  ])
  const used = seconds(reply)
  if (used === undefined) throw storeUnavailable()
  return used
}

export async function liveRun(account: string, rid: string, store = persistentStore): Promise<LiveRun | undefined> {
  if (!Schema.is(Uuid)(account) || !Schema.is(RunId)(rid)) throw invalidRequest()
  const reply = await store(["EVAL", READ, "1", liveKey(account), rid])
  if (reply === null) return undefined
  const run = typeof reply === "string" ? Option.getOrUndefined(decodeRun(reply)) : undefined
  if (!run) throw storeUnavailable()
  return {
    startedAt: run.startedAt,
    deadline: run.deadline,
    lastReport: run.lastReport,
    ...(run.lastRequest === undefined ? {} : { lastRequest: run.lastRequest }),
    epoch: run.epoch,
    repo: run.repo,
    thr: run.thr,
    src: run.src,
    pur: run.pur,
    ...(run.counted ? { counted: true as const } : {}),
    gen: run.gen,
    jti: run.jti,
    ...(run.triggerSource !== undefined && run.triggerPurpose !== undefined
      ? { triggerSource: run.triggerSource, triggerPurpose: run.triggerPurpose }
      : {}),
  }
}

/** The part of Codium's `ModelPlanCaller` the hook reads, typed structurally so no Codium file is imported. */
export type CloudAgentsGatewayCaller = { kind: string; account: { id: string }; run?: { id: string; service: string } }

/**
 * For Codium's `registerGatewayHook` (A59). It reads `afterSettle` only as "a request of this run ended at endedAt",
 * never as proof that Codium's own ledger holds a charge, and it never rejects into the gateway: a miss is logged with
 * the run id only, and the run's heartbeats still bound its charge.
 */
export const cloudAgentsGatewayHook = {
  id: "cloud-agents",
  afterSettle(caller: CloudAgentsGatewayCaller, context: { endedAt: number }): Promise<void> {
    const run = caller.run
    if (caller.kind !== "run" || run?.service !== "cloud-agents") return Promise.resolve()
    return recordCodiumRequest(caller.account.id, run.id, context.endedAt).catch(() => logLedgerMiss(run.id))
  },
}

function logLedgerMiss(runId: string) {
  console.warn("Vector cloud-agents ledger miss", Schema.is(RunId)(runId) ? { runId } : {})
}

function validReserve(input: ReserveInput) {
  const allowance = input.allowance
  const limits = allowance.limits
  return (
    Schema.is(Uuid)(input.account) &&
    Schema.is(RunId)(input.rid) &&
    Schema.is(Decimal)(input.repositoryId) &&
    Schema.is(Thread)(input.thread) &&
    Schema.is(Generation)(input.generation) &&
    Schema.is(Jti)(input.jti) &&
    Schema.is(Source)(input.source) &&
    Schema.is(Purpose)(input.purpose) &&
    // Only a GitHub schedule event is a scheduled run, so a scheduled purpose can never skip the daily count.
    (input.source === "github-schedule") === (input.purpose === "scheduled") &&
    allowance.active === true &&
    Schema.is(Epoch)(allowance.meterEpoch) &&
    Schema.is(Time)(allowance.periodEnd) &&
    whole(allowance.allowanceSeconds, 0) &&
    whole(limits?.atOnce, 1) &&
    whole(limits?.longestRunMin, 1) &&
    whole(limits?.scheduledPerDay, 0) &&
    (input.consumeKey === undefined || (typeof input.consumeKey === "string" && TICKET_KEY.test(input.consumeKey))) &&
    (input.trigger === undefined ||
      (Schema.is(TriggerSource)(input.trigger.source) &&
        Schema.is(TriggerPurpose)(input.trigger.purpose) &&
        input.source === "github-dispatch" &&
        input.purpose === (input.trigger.purpose === "review" ? "review" : "task"))) &&
    (input.renewalJti === undefined ||
      (Schema.is(Jti)(input.renewalJti) && input.trigger !== undefined && input.consumeKey === undefined)) &&
    Schema.is(Time)(input.now)
  )
}

function seconds(value: unknown) {
  return Schema.is(Whole)(value) ? Number(value) : undefined
}

function whole(value: unknown, least: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= least
}

// Scheduled mints per UTC day (2.7). Private: only this module counts them.
function scheduledKey(account: string, at: number) {
  return `${PREFIX}sched:${account}:${new Date(at).toISOString().slice(0, 10)}`
}

// The decoder, the charge formula and the idle rule every script shares. A record that fails the decoder makes the
// whole script answer 'corrupt' before its first write; a count (used seconds, scheduled mints) is absent or a decimal.
const RULES = `
local IDLE_MS = ${GithubAgents.IDLE_SECONDS * 1000}
local KEPT_MS = ${LIVE_KEPT_MS}
local sources = { ['github-comment'] = true, ['github-dispatch'] = true, ['github-schedule'] = true }
local purposes = { task = true, review = true, scheduled = true }
local triggerSources = { ${RUN_SOURCES.map((source) => `[${JSON.stringify(source)}] = true`).join(", ")} }
local triggerPurposes = { task = true, review = true, incident = true, changes = true }
local fields = { startedAt = true, deadline = true, lastReport = true, lastRequest = true, epoch = true, repo = true,
  thr = true, src = true, pur = true, counted = true, gen = true, jti = true, triggerSource = true, triggerPurpose = true }
local function whole(value, least)
  return type(value) == 'number' and value >= least and value <= 9007199254740991 and math.floor(value) == value
end
local function text(value, shape, longest)
  return type(value) == 'string' and #value <= longest and string.match(value, shape) ~= nil
end
local function thread(value)
  return text(value, '^[1-9]%d*$', 10) or text(value, '^dispatch%-[1-9]%d*$', 29)
    or (text(value, '^schedule%-[0-9a-f]+$', 17) and #value == 17)
end
local function decode(raw)
  local ok, run = pcall(cjson.decode, raw)
  if not ok or type(run) ~= 'table' then return nil end
  for name in pairs(run) do
    if not fields[name] then return nil end
  end
  if not (whole(run.startedAt, 1) and whole(run.deadline, 1) and whole(run.lastReport, 1)
    and (run.lastRequest == nil or whole(run.lastRequest, 1)) and whole(run.gen, 1)) then return nil end
  if run.deadline <= run.startedAt or (run.deadline - run.startedAt) % 1000 ~= 0 or run.lastReport < run.startedAt
    or (run.lastRequest ~= nil and run.lastRequest < run.startedAt) then return nil end
  if not (sources[run.src] and purposes[run.pur] and thread(run.thr) and text(run.epoch, '^%w[%w_:%.%-]*$', 128)
    and text(run.repo, '^[1-9]%d*$', 16) and tonumber(run.repo) <= 9007199254740991
    and text(run.jti, '^[%w_%-]+$', 22) and #run.jti == 22) then return nil end
  if run.counted ~= nil and not (run.counted == true and run.src == 'github-schedule') then return nil end
  if run.triggerSource ~= nil or run.triggerPurpose ~= nil then
    if not triggerSources[run.triggerSource] or not triggerPurposes[run.triggerPurpose] or run.src ~= 'github-dispatch'
      or run.pur ~= (run.triggerPurpose == 'review' and 'review' or 'task') then return nil end
  end
  return run
end
local function count(raw)
  if not raw then return 0 end
  if raw == '0' or (string.match(raw, '^[1-9]%d*$') and #raw <= 16) then return tonumber(raw) end
  return nil
end
local function int(value)
  return string.format('%.0f', value)
end
local function encode(run)
  local parts = { '"startedAt":' .. int(run.startedAt), '"deadline":' .. int(run.deadline),
    '"lastReport":' .. int(run.lastReport) }
  if run.lastRequest then parts[#parts + 1] = '"lastRequest":' .. int(run.lastRequest) end
  for _, name in ipairs({ 'epoch', 'repo', 'thr', 'src', 'pur' }) do
    parts[#parts + 1] = '"' .. name .. '":' .. cjson.encode(run[name])
  end
  if run.counted then parts[#parts + 1] = '"counted":true' end
  parts[#parts + 1] = '"gen":' .. int(run.gen)
  parts[#parts + 1] = '"jti":' .. cjson.encode(run.jti)
  if run.triggerSource then
    parts[#parts + 1] = '"triggerSource":' .. cjson.encode(run.triggerSource)
    parts[#parts + 1] = '"triggerPurpose":' .. cjson.encode(run.triggerPurpose)
  end
  return '{' .. table.concat(parts, ',') .. '}'
end
local function active(run)
  return math.max(run.lastReport, run.lastRequest or 0)
end
local function reservation(run)
  return (run.deadline - run.startedAt) / 1000
end
local function charge(run)
  return math.ceil(math.min(math.max(active(run) - run.startedAt, 0), run.deadline - run.startedAt) / 1000)
end
local function idle(run, now)
  return now - active(run) > IDLE_MS
end
local function kind(key, expected)
  local found = redis.call('TYPE', key).ok
  return found == expected or found == 'none'
end
-- Every run of the account, decoded, or nil when any one is corrupt.
local function read(key)
  local stored = redis.call('HGETALL', key)
  local runs = {}
  for i = 1, #stored, 2 do
    local run = decode(stored[i + 1])
    if not run then return nil end
    runs[stored[i]] = run
  end
  return runs
end
-- A fresh reserve keeps the hash at least as long as the used key it charged and the new run's deadline plus a day,
-- and nothing shortens it while it holds runs (HDEL of the last one removes it). So no used key outlives a record whose
-- reservation it holds, and a run nobody settles is settled by the formula before its used key is read.
local function keep(key, ms)
  if redis.call('PTTL', key) < ms then redis.call('PEXPIRE', key, int(ms)) end
end
`

// KEYS: live, used(epoch), today's scheduled count, revocation, optionally binding/generation, then optional ticket.
// ARGV: now, rid, epoch, repository id, thread, source, purpose, generation, jti, at once, longest run (s),
// scheduled a day, allowance (s), used's expiry (ms), account, bound-admission flag, trigger source/purpose, renewal JTI.
const RESERVE = `${RULES}
if not (kind(KEYS[1], 'hash') and kind(KEYS[2], 'string') and kind(KEYS[3], 'string') and kind(KEYS[4], 'string')) then return 'corrupt' end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'revoked' end
local ticket = KEYS[5]
if ARGV[16] == '1' then
  if not kind(KEYS[5], 'hash') or not kind(KEYS[6], 'string') then return 'corrupt' end
  if redis.call('HGET', KEYS[5], 'account') ~= ARGV[15]
    or redis.call('HGET', KEYS[5], 'generation') ~= ARGV[8]
    or redis.call('GET', KEYS[6]) ~= ARGV[8]
    or redis.call('HEXISTS', KEYS[5], 'suspended') == 1 then return 'binding' end
  ticket = KEYS[7]
end
local used = count(redis.call('GET', KEYS[2]))
local scheduled = count(redis.call('GET', KEYS[3]))
local runs = read(KEYS[1])
if not (used and scheduled and runs) then return 'corrupt' end
local now, rid, epoch, generation = tonumber(ARGV[1]), ARGV[2], ARGV[3], tonumber(ARGV[8])
local validTicket = ticket and redis.call('EXISTS', ticket) == 1
if ticket and ARGV[16] == '1' then
  if not kind(ticket, 'string') then return 'corrupt' end
  local raw = redis.call('GET', ticket)
  if raw then
    local decoded, proof = pcall(cjson.decode, raw)
    if not decoded or type(proof) ~= 'table' or not whole(proof.exp, 1) or not whole(proof.generation, 1)
      or type(proof.account) ~= 'string' or type(proof.repositoryId) ~= 'string'
      or not triggerSources[proof.source] or not triggerPurposes[proof.purpose] then return 'corrupt' end
    local fields = 0; for _ in pairs(proof) do fields = fields + 1 end
    if fields ~= 6 then return 'corrupt' end
    validTicket = proof.account == ARGV[15] and proof.repositoryId == ARGV[4] and proof.generation == generation
      and proof.source == ARGV[17] and proof.purpose == ARGV[18] and now < proof.exp
  end
end
local previous = runs[rid]
-- A bot without a fresh ticket may only rotate the exact live authority already observed. Stale peeks never
-- become a fresh admission after settlement, an idle sweep, rebind, erasure, or another successful renewal.
if ARGV[19] ~= '' and (not previous or previous.gen ~= generation or previous.jti ~= ARGV[19]
  or previous.triggerSource ~= ARGV[17] or previous.triggerPurpose ~= ARGV[18]
  or idle(previous, now) or now >= previous.deadline) then return 'ticket' end
if previous and previous.gen == generation and ARGV[16] == '1'
  and ((previous.triggerSource or '') ~= ARGV[17] or (previous.triggerPurpose or '') ~= ARGV[18]) then return 'ticket' end
-- One check run is one schedule event, counted when it first reserved: a reserve that replaces its own earlier record
-- (after a generation change, or once that record went idle) is not counted again, at the cap or otherwise.
local counts = ARGV[6] == 'github-schedule' and not (runs[rid] and runs[rid].src == 'github-schedule')
local returned, removed = 0, {}
-- A run of another epoch (idle, or replaced after a generation change) frees its slot and keeps its whole reservation
-- in its own epoch, whose used key this script was not given.
local function settle(id, run)
  if run.epoch == epoch then returned = returned + reservation(run) - charge(run) end
  removed[#removed + 1] = id
  runs[id] = nil
end
for id, run in pairs(runs) do
  if idle(run, now) then settle(id, run) end
end
local current = runs[rid]
local answer
if current and current.gen == generation then
  -- Past its deadline a new token would be dead at once, and a new jti would kill the one the run still settles with.
  answer = now < current.deadline and 'renew' or 'at-once'
elseif current and current.gen > generation then
  -- A newer mint of this check run holds it; overwriting would kill that token.
  answer = 'at-once'
else
  if current then settle(rid, current) end
  local live, others = 0, 0
  for _, run in pairs(runs) do
    live = live + 1
    if run.epoch ~= epoch then others = others + reservation(run) end
  end
  -- used(epoch) already holds this epoch's live reservations.
  local left = tonumber(ARGV[13]) - (used - returned) - others
  -- The mint only peeked the ticket, so this is where it is single-use: another check run's reservation may have
  -- consumed it since, or it expired. Checked before the slots, which a retry could find free.
  if ticket and not validTicket then answer = 'ticket'
  elseif live >= tonumber(ARGV[10]) then answer = 'at-once'
  elseif counts and scheduled >= tonumber(ARGV[12]) then answer = 'scheduled'
  elseif left < ${GithubAgents.MIN_LEFT_SECONDS} then answer = 'hours'
  else answer = math.min(tonumber(ARGV[11]), left) end
end
if returned > used then return 'corrupt' end
if #removed > 0 then redis.call('HDEL', KEYS[1], unpack(removed)) end
if returned > 0 then redis.call('DECRBY', KEYS[2], int(returned)) end
if answer == 'renew' then
  current.jti = ARGV[9]
  redis.call('HSET', KEYS[1], rid, encode(current))
  if ticket then redis.call('DEL', ticket) end
  return { 'ok', int(current.startedAt), int(current.deadline), '1', current.epoch, current.thr, current.src, current.pur,
    current.triggerSource or '', current.triggerPurpose or '' }
end
if type(answer) == 'string' then return answer end
local run = { startedAt = now, deadline = now + answer * 1000, lastReport = now, epoch = epoch, repo = ARGV[4],
  thr = ARGV[5], src = ARGV[6], pur = ARGV[7], counted = counts or nil, gen = generation, jti = ARGV[9],
  triggerSource = ARGV[17] ~= '' and ARGV[17] or nil, triggerPurpose = ARGV[18] ~= '' and ARGV[18] or nil }
redis.call('HSET', KEYS[1], rid, encode(run))
redis.call('INCRBY', KEYS[2], int(answer))
redis.call('PEXPIRE', KEYS[2], ARGV[14])
if counts then
  redis.call('INCR', KEYS[3])
  redis.call('PEXPIRE', KEYS[3], ${SCHEDULED_KEPT_MS})
end
if ticket then redis.call('DEL', ticket) end
keep(KEYS[1], math.max(tonumber(ARGV[14]), answer * 1000 + KEPT_MS))
return { 'ok', int(run.startedAt), int(run.deadline), '0', epoch, run.thr, run.src, run.pur,
  run.triggerSource or '', run.triggerPurpose or '' }
`

// KEYS: live. ARGV: rid, jti, now. Touches only its own run: idle runs are judged by the calls that need slots or a sum.
const REPORT = `${RULES}
if not kind(KEYS[1], 'hash') then return 'corrupt' end
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return { '0' } end
local run = decode(raw)
if not run then return 'corrupt' end
if run.jti ~= ARGV[2] then return { '0' } end
local now = tonumber(ARGV[3])
if now > run.lastReport then
  run.lastReport = now
  redis.call('HSET', KEYS[1], ARGV[1], encode(run))
end
return { '1', int(run.deadline) }
`

// KEYS: live. ARGV: rid, the request's end. A request that ended before the run started is not the run's: the gateway
// and the mint read different clocks.
const RECORD = `${RULES}
if not kind(KEYS[1], 'hash') then return 'corrupt' end
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 'missing' end
local run = decode(raw)
if not run then return 'corrupt' end
local at = tonumber(ARGV[2])
if at < run.startedAt or at <= (run.lastRequest or 0) then return 'kept' end
run.lastRequest = at
redis.call('HSET', KEYS[1], ARGV[1], encode(run))
return 'recorded'
`

// KEYS: live, used(the token's epoch). ARGV: rid, jti, epoch. The charge reads only the record.
const SETTLE = `${RULES}
if not (kind(KEYS[1], 'hash') and kind(KEYS[2], 'string')) then return 'corrupt' end
local used = count(redis.call('GET', KEYS[2]))
local runs = read(KEYS[1])
if not (used and runs) then return 'corrupt' end
local run = runs[ARGV[1]]
if not run or run.jti ~= ARGV[2] then return { '0', '0' } end
local same = run.epoch == ARGV[3]
local charged = same and charge(run) or reservation(run)
local returned = reservation(run) - charged
if returned > used then return 'corrupt' end
redis.call('HDEL', KEYS[1], ARGV[1])
if returned > 0 then redis.call('DECRBY', KEYS[2], int(returned)) end
return { '1', int(charged) }
`

// The run record and ledger are checked before any write. A lost response is safe to retry: the ended record is
// the durable receipt, and never takes the retry's new outcome. Shared RULES supplies the sole charge formula.
const SETTLE_RECORDED = `${RULES}
for i, expected in ipairs({'hash', 'string', 'hash', 'string', 'hash', 'string'}) do
  if not kind(KEYS[i], expected) then return 'corrupt' end
end
if redis.call('EXISTS', KEYS[4]) == 1 or redis.call('HGET', KEYS[5], 'account') ~= ARGV[4]
  or redis.call('HGET', KEYS[5], 'generation') ~= ARGV[5] or redis.call('GET', KEYS[6]) ~= ARGV[5]
  or redis.call('HEXISTS', KEYS[5], 'suspended') == 1 then return 'stale' end
local record = redis.call('HMGET', KEYS[3], 'account', 'generation', 'jti', 'startedAt', 'endedAt', 'outcome', 'verdict')
if record[1] ~= ARGV[4] or record[2] ~= ARGV[5] or record[3] ~= ARGV[2] then return 'stale' end
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local run = raw and decode(raw) or nil
if raw and not run then return 'corrupt' end
if run and (run.jti ~= ARGV[2] or run.gen ~= tonumber(ARGV[5])) then return 'stale' end
if record[5] then
  local outcomes = {changes = 'pass', ['no-changes'] = 'none', draft = 'fail', failed = 'fail', refused = 'none', cancelled = 'none'}
  if run or not outcomes[record[6]] or outcomes[record[6]] ~= record[7]
    or not tonumber(record[5]) or not tonumber(record[4]) or tonumber(record[5]) < tonumber(record[4]) then return 'corrupt' end
  return record[6]
end
if not run then return 'stale' end
if record[6] or record[7] or tonumber(record[4]) ~= run.startedAt or tonumber(ARGV[6]) < run.startedAt then return 'corrupt' end
local used = count(redis.call('GET', KEYS[2]))
if not used then return 'corrupt' end
local charged = run.epoch == ARGV[3] and charge(run) or reservation(run)
local returned = reservation(run) - charged
if returned > used then return 'corrupt' end
redis.call('HDEL', KEYS[1], ARGV[1])
if returned > 0 then redis.call('DECRBY', KEYS[2], int(returned)) end
redis.call('HSET', KEYS[3], 'endedAt', ARGV[6], 'outcome', ARGV[7], 'verdict', ARGV[8])
redis.call('EXPIRE', KEYS[3], ${90 * 86_400})
return ARGV[7]
`

// KEYS: live, used(epoch), the scheduled count of the start's UTC day. ARGV: rid, jti, epoch, startedAt.
const RELEASE = `${RULES}
if not (kind(KEYS[1], 'hash') and kind(KEYS[2], 'string') and kind(KEYS[3], 'string')) then return 'corrupt' end
local used = count(redis.call('GET', KEYS[2]))
local scheduled = count(redis.call('GET', KEYS[3]))
local runs = read(KEYS[1])
if not (used and scheduled and runs) then return 'corrupt' end
local run = runs[ARGV[1]]
if not run or run.jti ~= ARGV[2] or run.epoch ~= ARGV[3] or run.startedAt ~= tonumber(ARGV[4]) then return 'kept' end
if reservation(run) > used then return 'corrupt' end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('DECRBY', KEYS[2], int(reservation(run)))
if run.counted and scheduled > 0 then redis.call('DECR', KEYS[3]) end
return 'released'
`

// KEYS: live, used(epoch). ARGV: epoch, now. Only this epoch's idle runs are settled: the epoch is the caller's, which
// may be stale, and removing another epoch's run without its give-back would overcharge that epoch.
const USED = `${RULES}
if not (kind(KEYS[1], 'hash') and kind(KEYS[2], 'string')) then return 'corrupt' end
local used = count(redis.call('GET', KEYS[2]))
local runs = read(KEYS[1])
if not (used and runs) then return 'corrupt' end
local now = tonumber(ARGV[2])
local returned, removed, live = 0, {}, 0
for id, run in pairs(runs) do
  if run.epoch == ARGV[1] and idle(run, now) then
    returned = returned + reservation(run) - charge(run)
    removed[#removed + 1] = id
  elseif run.epoch == ARGV[1] then
    live = live + reservation(run)
  end
end
local settled = used - returned - live
if settled < 0 then return 'corrupt' end
if #removed > 0 then redis.call('HDEL', KEYS[1], unpack(removed)) end
if returned > 0 then redis.call('DECRBY', KEYS[2], int(returned)) end
return int(settled)
`

const READ = `return redis.call('HGET', KEYS[1], ARGV[1])`

function invalidRequest() {
  return new ApiError(400, "INVALID_REQUEST", "Send only the supported run ledger fields.")
}

function storeUnavailable() {
  return new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected GitHub services are temporarily unavailable.")
}
