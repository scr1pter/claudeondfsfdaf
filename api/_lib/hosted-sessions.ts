import { randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { Hosted } from "../../packages/schema/src/hosted.js"
import { codiumKey } from "./codium-keys.js"
import { readSwitch } from "./codium-switches.js"
import {
  hostedAccess,
  hostedBrowserAllowed,
  hostedCaps,
  hostedOpen,
  hoursUsedShare,
  requireHostedStart,
  unavailable,
  type HostedCaps,
} from "./hosted-entitlement.js"
import { closeBlock, hostedAccount, hostedLedgerConfigured, openBlock } from "./hosted-ledger.js"
import {
  MAX_COMPUTERS,
  TIMEOUT_GRACE_MS,
  bootHostedComputer,
  computerName,
  destroyHostedComputer,
  hostedProviderConfigured,
  setHostedRunToken,
  startHostedComputer,
  stopHostedComputer,
  type ProviderOptions,
} from "./hosted-provider.js"
import { HOLD_MINUTES } from "./hosted-rates.js"
import {
  hostedRunSigningConfigured,
  hostedViewerConfigured,
  mintDownloadToken,
  mintHostedRunToken,
  mintViewerToken,
  readHostedRunToken,
  refuseBrowserShaped,
  viewerPublicKey,
  type HostedRunClaims,
} from "./hosted-tokens.js"
import { ApiError, type ApiRequest } from "./http.js"
import { stripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"
import { presignR2, r2Configured } from "./r2-presign.js"
import { requireUnrevokedAccount } from "./revocation.js"
import { runTokenRevoked } from "./codium-provisioners.js"

/*
 * The cloud computer's sessions (contract WP A53): one job on one computer Vector hosts, from the start checks to the
 * stop, with take-over, the live view's tokens, the daemon's heartbeat and the session's files. The reaper, the nightly
 * job, the drift check and the hosted provisioner (hosted-crons.ts) drive the same records.
 *
 * Money (M8). A session never runs on time nobody held: its first block of time is held before the computer starts
 * (WP A51's `openBlock`), the reaper holds each next block before the current one ends, and when one cannot be held the
 * session wraps up and stops by the end of the last hold (`stopBy`). The computer is told to stop before its block is
 * closed, so every minute it ran is charged; a block nothing closed is charged its whole hold when it lapses.
 *
 * Trust (S1, S7). Every limit comes from the entitlement snapshot and the owner's switches, never from what a client
 * sends. The computer holds no long-lived credential: its run token is added by the provider's proxy for the run-API
 * host only and lives about as long as the block it was minted with; the live view's tokens last five minutes and are
 * single use; a request carrying a run token is refused when it looks like a browser's (`Origin`, `Sec-Fetch-*`,
 * cookies), so no web page the computer's browser opens can borrow it.
 *
 * Store keys (all under the Codium prefix; §4.6 names `hosted:running:<id>`, `hosted:jobs:due` and
 * `hosted:minutes:<id>:<epoch>`, the rest are this package's):
 * - `hosted:session:<sid>`       the session record (JSON, compare-and-set), kept 35 days after it ends;
 * - `hosted:sessions:<account>`  ZSET of the account's sessions by start time;
 * - `hosted:live`                ZSET of sessions whose computer may be running (the reaper's list);
 * - `hosted:lease:<account>`     HASH computer number → `<sid>:<until>`: computers at once, by lease;
 * - `hosted:job:<sid>`           the job prompt, until the computer's daemon collects it;
 * - `hosted:beat:<sid>`          the daemon's last report; `hosted:model:<sid>` the session's last model request;
 * - `hosted:viewer:<jti>`        viewer tokens issued (5 minutes);
 * - `hosted:computers:<account>` SET of computer numbers the account has had; `hosted:names` HASH name → account;
 * - `hosted:suspend:<account>`, `hosted:suspended`  fair-use or owner holds on the account's cloud computer;
 * - `hosted:egress:<account>:<day>`, `hosted:pages:<account>:<hour>`  fair-use counters;
 * - `hosted:recent`              ZSET of accounts by their last session activity (the drift check's list).
 */

const DAY_MS = 86_400_000
const ACCOUNT = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
/** A session record is kept this long after it ends (drift checks, the true-up and the download link). */
export const SESSION_KEEP_MS = 35 * DAY_MS
/** A computer's lease outlives its block's stopBy by this much, so the reconciler sees it first. */
const LEASE_SLACK_MS = 2 * 60_000
/** A run token outlives the block it was minted with by this much. */
const TOKEN_SLACK_MS = 10 * 60_000
/** The reaper refreshes a run token once it has less than this left. */
export const TOKEN_REFRESH_MS = 8 * 60_000
/** A session stuck in `starting` this long is ended. */
export const START_STALE_MS = 10 * 60_000
/** A computer the provider cannot stop is given up on this long past its stopBy (its block lapsed and was charged). */
export const STOP_GIVE_UP_MS = 30 * 60_000
/** S3's largest single upload, which R2 shares: the packed files must fit one PUT. */
const ARCHIVE_MAX_BYTES = 5 * 1024 ** 3

export type SessionOptions = ProviderOptions & { fetcher?: typeof fetch; clock?: () => number }

// ── Store keys ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const hostedSessionKey = (id: string) => codiumKey("hosted", "session", id)
export const hostedSessionsKey = (account: string) => codiumKey("hosted", "sessions", account)
export const hostedLiveKey = () => codiumKey("hosted", "live")
export const hostedLeaseKey = (account: string) => codiumKey("hosted", "lease", account)
export const hostedJobKey = (id: string) => codiumKey("hosted", "job", id)
export const hostedBeatKey = (id: string) => codiumKey("hosted", "beat", id)
export const hostedModelKey = (id: string) => codiumKey("hosted", "model", id)
export const hostedViewerKey = (jti: string) => codiumKey("hosted", "viewer", jti)
export const hostedComputersKey = (account: string) => codiumKey("hosted", "computers", account)
export const hostedNamesKey = () => codiumKey("hosted", "names")
export const hostedSuspendKey = (account: string) => codiumKey("hosted", "suspend", account)
export const hostedSuspendedKey = () => codiumKey("hosted", "suspended")
export const hostedEgressKey = (account: string, day: string) => codiumKey("hosted", "egress", account, day)
export const hostedPagesKey = (account: string, hour: string) => codiumKey("hosted", "pages", account, hour)
export const hostedRecentKey = () => codiumKey("hosted", "recent")

// ── Records ────────────────────────────────────────────────────────────────────────────────────────────────────────

const Takeover = Schema.Struct({ since: Schema.Number, until: Schema.Number })
const Download = Schema.Struct({
  requestedAt: Schema.Number,
  readyAt: Schema.optional(Schema.Number),
  bytes: Schema.optional(Schema.Number),
})
const SessionRecord = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  account: Schema.String,
  computer: Schema.Int,
  size: Schema.Literals(Hosted.SIZES),
  source: Schema.Literals(Hosted.SESSION_SOURCES),
  title: Schema.optional(Schema.String),
  state: Schema.Literals(Hosted.SESSION_STATES),
  /** Why the session wraps up or ended. */
  reason: Schema.optional(Schema.Literals(Hosted.END_REASONS)),
  createdAt: Schema.Number,
  /** When the job must be done: the first block's start plus the job's minutes. */
  deadline: Schema.Number,
  /** Whether the computer's browser may be used (§4.2). */
  browser: Schema.Boolean,
  /** The period it started in (the drift check). */
  periodStart: Schema.Number,
  /** The current block: its number, start, when its minutes are up and the latest it may run on its hold. */
  block: Schema.Int,
  blockStartedAt: Schema.Number,
  endsAt: Schema.Number,
  stopBy: Schema.Number,
  /** When the first block started, i.e. when the session's time began. */
  startedAt: Schema.optional(Schema.Number),
  runningAt: Schema.optional(Schema.Number),
  viewerUrl: Schema.optional(Schema.String),
  /** When the computer's current run token expires. */
  tokenUntil: Schema.optional(Schema.Number),
  takeover: Schema.optional(Takeover),
  releasedAt: Schema.optional(Schema.Number),
  wrapBy: Schema.optional(Schema.Number),
  stoppedAt: Schema.optional(Schema.Number),
  endedAt: Schema.optional(Schema.Number),
  download: Schema.optional(Download),
})
export type SessionRecord = typeof SessionRecord.Type

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(SessionRecord))

/**
 * SAVE. Compare-and-set of one record: writes ARGV[2] (lifetime ARGV[3] ms) only while the key still holds ARGV[1]
 * ('' for a key that does not exist yet). 1 when written, 0 when the record moved on.
 */
const SAVE = `local current = redis.call('GET', KEYS[1]) if not current then current = '' end if current ~= ARGV[1] then return 0 end redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1`

/**
 * CLAIM. Computers at once, by lease: the session ARGV[1] takes the lowest of computers 1..ARGV[2] whose lease is free
 * or lapsed (until ≤ ARGV[4]), holding it until ARGV[3]; a session that already holds one keeps it. The hash lives at
 * least ARGV[5] ms. Answers the computer, or 0 when every one is leased.
 */
const CLAIM = `local now = tonumber(ARGV[4]) local free = nil
for n = 1, tonumber(ARGV[2]) do
  local v = redis.call('HGET', KEYS[1], tostring(n))
  if v then
    local s, u = string.match(v, '^([^:]+):(%d+)$')
    if s == ARGV[1] then redis.call('HSET', KEYS[1], tostring(n), ARGV[1] .. ':' .. ARGV[3]) return n end
    if (not s or tonumber(u) <= now) and not free then free = n end
  elseif not free then free = n end
end
if not free then return 0 end
redis.call('HSET', KEYS[1], tostring(free), ARGV[1] .. ':' .. ARGV[3])
local ttl = redis.call('PTTL', KEYS[1]) if ttl < tonumber(ARGV[5]) then redis.call('PEXPIRE', KEYS[1], ARGV[5]) end
return free`

/**
 * LEASE. Renews (ARGV[3] = until, the hash living at least ARGV[4] ms) or releases (ARGV[3] = '') computer ARGV[1]'s
 * lease, only while session ARGV[2] holds it. 1 when done, 0 when another session holds it or none.
 */
const LEASE = `local v = redis.call('HGET', KEYS[1], ARGV[1]) if not v or string.sub(v, 1, string.len(ARGV[2]) + 1) ~= ARGV[2] .. ':' then return 0 end
if ARGV[3] == '' then redis.call('HDEL', KEYS[1], ARGV[1]) return 1 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. ':' .. ARGV[3])
local ttl = redis.call('PTTL', KEYS[1]) if ttl < tonumber(ARGV[4]) then redis.call('PEXPIRE', KEYS[1], ARGV[4]) end
return 1`

export const HOSTED_SESSION_SCRIPTS = Object.freeze({ SAVE, CLAIM, LEASE })

function store(command: readonly (string | number)[], fetcher: typeof fetch) {
  return persistentStore(command, fetcher)
}

/** A session's record, or undefined when there is none (or it cannot be read as one). */
export async function readSessionRecord(id: string, fetcher: typeof fetch = fetch) {
  if (!Hosted.SESSION_ID.test(id)) return undefined
  const raw = await store(["GET", hostedSessionKey(id)], fetcher)
  if (typeof raw !== "string") return undefined
  return Option.getOrUndefined(decodeRecord(raw))
}

function recordKeepMs(record: SessionRecord, now: number) {
  const end = record.endedAt ?? Math.max(record.deadline + TIMEOUT_GRACE_MS, now)
  return Math.max(60_000, end + SESSION_KEEP_MS - now)
}

/**
 * Changes a record with compare-and-set: `change` gets the current record and answers the next one, or undefined to
 * leave it. Retried when another writer moved it in between. Answers the record as stored.
 */
export async function updateSessionRecord(
  id: string,
  change: (record: SessionRecord) => SessionRecord | undefined,
  options: { fetcher?: typeof fetch; clock?: () => number } = {},
) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = await store(["GET", hostedSessionKey(id)], fetcher)
    if (typeof raw !== "string") throw notFound()
    const current = Option.getOrUndefined(decodeRecord(raw))
    if (!current) throw unavailable()
    const next = change(current)
    if (!next) return current
    const saved = await store(
      ["EVAL", SAVE, 1, hostedSessionKey(id), raw, JSON.stringify(next), recordKeepMs(next, clock())],
      fetcher,
    )
    if (Number(saved) === 1) return next
  }
  throw unavailable()
}

async function createRecord(record: SessionRecord, fetcher: typeof fetch, now: number) {
  const saved = await store(
    ["EVAL", SAVE, 1, hostedSessionKey(record.id), "", JSON.stringify(record), recordKeepMs(record, now)],
    fetcher,
  )
  if (Number(saved) !== 1) throw unavailable()
}

/** A session as its owner sees it: states, times and counts (P1). */
export function sessionView(record: SessionRecord): Hosted.SessionView {
  return {
    id: record.id,
    state: record.state,
    ...(record.reason ? { reason: record.reason } : {}),
    computer: record.computer,
    size: record.size,
    source: record.source,
    ...(record.title ? { title: record.title } : {}),
    createdAt: record.createdAt,
    deadline: record.deadline,
    ...(record.runningAt !== undefined ? { runningAt: record.runningAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.wrapBy !== undefined && record.state === "wrapping" ? { wrapBy: record.wrapBy } : {}),
    ...(record.takeover && record.state === "takeover" ? { takeover: record.takeover } : {}),
    ...(record.download
      ? {
          download: {
            requestedAt: record.download.requestedAt,
            ...(record.download.readyAt !== undefined ? { readyAt: record.download.readyAt } : {}),
          },
        }
      : {}),
  }
}

// ── Configuration ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why cloud computer sessions cannot run here, as setting names only: the provider (WP A52), the ledger (WP A51) and
 * the two signing keys. Empty when they can. `computer`'s readiness in the perk listing is this list being empty.
 */
export function hostedSessionProblems(options: Pick<SessionOptions, "provider"> = {}) {
  const problems: string[] = []
  if (options.provider === undefined ? !hostedProviderConfigured() : !options.provider.configured())
    problems.push("the provider (VECTOR_HOSTED_PROVIDER and its settings)")
  if (!hostedLedgerConfigured()) problems.push("the ledger (SUPABASE_*, VECTOR_HOSTED_ACCOUNT_SALT)")
  if (!hostedRunSigningConfigured()) problems.push("VECTOR_HOSTED_RUN_SIGNING_KEY")
  if (!hostedViewerConfigured()) problems.push("VECTOR_HOSTED_VIEWER_SIGNING_KEY")
  return problems
}

export function hostedSessionsConfigured(options: Pick<SessionOptions, "provider"> = {}) {
  return hostedSessionProblems(options).length === 0
}

// ── Suspensions ────────────────────────────────────────────────────────────────────────────────────────────────────

export type Suspension = { reason: "abuse" | "owner"; detail?: string; at: number }

/** The hold on `account`'s cloud computer (a fair-use limit or the owner), or undefined. */
export async function readSuspension(account: string, fetcher: typeof fetch = fetch): Promise<Suspension | undefined> {
  const raw = await store(["GET", hostedSuspendKey(account)], fetcher)
  if (raw === null || raw === undefined) return undefined
  try {
    const value = JSON.parse(String(raw)) as Suspension
    if ((value.reason === "abuse" || value.reason === "owner") && Number.isFinite(value.at)) return value
  } catch {}
  // An unreadable hold still holds (fail closed).
  return { reason: "owner", at: 0 }
}

/** Puts a hold on `account`'s cloud computer; the reaper stops its sessions on its next pass. */
export async function suspendHostedAccount(
  account: string,
  input: { reason: Suspension["reason"]; detail?: string; at: number },
  fetcher: typeof fetch = fetch,
) {
  if (!ACCOUNT.test(account)) throw request()
  const value: Suspension = {
    reason: input.reason,
    ...(input.detail ? { detail: input.detail.slice(0, 200) } : {}),
    at: input.at,
  }
  await store(["SET", hostedSuspendKey(account), JSON.stringify(value)], fetcher)
  await store(["ZADD", hostedSuspendedKey(), input.at, account], fetcher)
  return value
}

/** Lifts the hold on `account`'s cloud computer. */
export async function releaseHostedSuspension(account: string, fetcher: typeof fetch = fetch) {
  if (!ACCOUNT.test(account)) throw request()
  await store(["DEL", hostedSuspendKey(account)], fetcher)
  await store(["ZREM", hostedSuspendedKey(), account], fetcher)
}

/** The accounts on hold, newest first (owner page). */
export async function listSuspensions(fetcher: typeof fetch = fetch) {
  const accounts = await store(["ZREVRANGE", hostedSuspendedKey(), 0, 199], fetcher)
  const found: (Suspension & { account: string })[] = []
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (typeof account !== "string") continue
    const suspension = await readSuspension(account, fetcher)
    if (suspension) found.push({ account, ...suspension })
  }
  return found
}

function suspendedError(suspension: Suspension) {
  return new ApiError(403, "HOSTED_FROZEN", "The cloud computer is on hold for this account. Contact Vector support.", {
    detail: { reason: suspension.reason === "abuse" ? "fair-use" : "owner" },
  })
}

// ── Leases ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function claimComputer(
  account: string,
  session: string,
  computers: number,
  until: number,
  now: number,
  fetcher: typeof fetch,
) {
  const claimed = await store(
    ["EVAL", CLAIM, 1, hostedLeaseKey(account), session, computers, until, now, until - now + DAY_MS],
    fetcher,
  )
  const computer = Number(claimed)
  if (!Number.isSafeInteger(computer) || computer < 0 || computer > MAX_COMPUTERS) throw unavailable()
  return computer
}

async function renewLease(record: SessionRecord, until: number, now: number, fetcher: typeof fetch) {
  await store(
    ["EVAL", LEASE, 1, hostedLeaseKey(record.account), record.computer, record.id, until, until - now + DAY_MS],
    fetcher,
  )
}

async function releaseLease(record: SessionRecord, fetcher: typeof fetch) {
  await store(["EVAL", LEASE, 1, hostedLeaseKey(record.account), record.computer, record.id, "", 0], fetcher)
}

/** Computer number → the session leasing it now, for `account`. */
export async function readLeases(account: string, fetcher: typeof fetch, now: number) {
  const flat = await store(["HGETALL", hostedLeaseKey(account)], fetcher)
  const leases = new Map<number, string>()
  if (!Array.isArray(flat)) return leases
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const match = /^([^:]+):(\d+)$/.exec(String(flat[index + 1]))
    const computer = Number(flat[index])
    if (match && Number(match[2]) > now && Number.isSafeInteger(computer)) leases.set(computer, match[1]!)
  }
  return leases
}

// ── Starting ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type StartInput = {
  size: Hosted.Size
  jobMinutes: number
  prompt: string
  title?: string
  source: Hosted.SessionSource
}

/**
 * The body of a start: `{size, jobMinutes, prompt, title?}`. The source is the caller's, never the body's. Anything
 * else in the body is ignored, in particular any count, plan or hour: those come from the snapshot (S1).
 */
export function parseStart(input: unknown, source: Hosted.SessionSource): StartInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw request()
  const body = input as Record<string, unknown>
  if (typeof body.prompt !== "string") throw request("Say what the computer should do.")
  const prompt = body.prompt.trim()
  if (!prompt || prompt.length > Hosted.PROMPT_MAX || prompt.includes("\u0000"))
    throw request("Say what the computer should do, in at most 32,000 characters.")
  let title: string | undefined
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== "string") throw request()
    title = body.title.trim().replace(/\s+/g, " ")
    if (!title || title.length > Hosted.TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title)) throw request()
  }
  return {
    size: body.size as Hosted.Size,
    jobMinutes: body.jobMinutes as number,
    prompt,
    ...(title ? { title } : {}),
    source,
  }
}

/** A new session id: `hs_` and 26 base32 letters (130 random bits). */
export function newSessionId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
  const bytes = randomBytes(26)
  let id = "hs_"
  for (const byte of bytes) id += alphabet[byte & 31]
  return id
}

function tokenExpiry(stopBy: number, deadline: number) {
  return Math.min(stopBy + TOKEN_SLACK_MS, deadline + TIMEOUT_GRACE_MS)
}

function diskDays(caps: HostedCaps) {
  return Math.max(1, Math.min(90, caps.diskDays))
}

/**
 * Starts a cloud computer session for `account` (§WP A53's start checks, in order): the owner's switch, the provider
 * and the rest of the hosted configuration, the plan from the snapshot (state, size, job length, hours: WP A51's
 * `requireHostedStart`), a hold on the account, computers at once by lease, the first block's hold, creating or
 * resuming the computer with its run token, and the boot step. Anything that fails after the hold gives it back (or
 * charges only what the computer ran). Answers the session.
 */
export async function startHostedSession(
  account: string,
  input: StartInput,
  options: SessionOptions = {},
): Promise<Hosted.SessionView> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (hostedSessionProblems(options).length) throw unavailable()
  const suspension = await readSuspension(account, fetcher)
  if (suspension) throw suspendedError(suspension)
  const start = await requireHostedStart(account, { size: input.size, jobMinutes: input.jobMinutes }, { fetcher, clock })
  const now = clock()
  const id = newSessionId()
  const computer = await claimComputer(
    account,
    id,
    start.caps.computers,
    now + HOLD_MINUTES * 60_000 + LEASE_SLACK_MS,
    now,
    fetcher,
  )
  if (computer === 0)
    throw new ApiError(429, "HOSTED_BUSY", "All the cloud computers your plan includes are running. Stop one first.")
  let record: SessionRecord = {
    v: 1,
    id,
    account,
    computer,
    size: start.size,
    source: input.source,
    ...(input.title ? { title: input.title } : {}),
    state: "starting",
    createdAt: now,
    deadline: now + start.jobMinutes * 60_000,
    browser: start.browser,
    periodStart: start.snapshot.periodStart,
    block: 0,
    blockStartedAt: now,
    endsAt: now,
    stopBy: now,
  }
  try {
    await createRecord(record, fetcher, now)
    await store(["ZADD", hostedSessionsKey(account), now, id], fetcher)
    await store(["ZADD", hostedLiveKey(), now, id], fetcher)
    await store(["ZADD", hostedRecentKey(), now, account], fetcher)
    await store(["SADD", hostedComputersKey(account), computer], fetcher)
    await store(["HSET", hostedNamesKey(), computerName(account, computer), account], fetcher)
    await store(
      ["SET", hostedJobKey(id), JSON.stringify({ prompt: input.prompt, ...(input.title ? { title: input.title } : {}) }), "PX", start.jobMinutes * 60_000 + DAY_MS],
      fetcher,
    )
  } catch (error) {
    await abandonSession(record, fetcher, clock).catch(() => undefined)
    throw error
  }
  let block: Awaited<ReturnType<typeof openBlock>>
  try {
    block = await openBlock(account, { session: id, size: start.size }, { fetcher, clock })
  } catch (error) {
    await abandonSession(record, fetcher, clock).catch(() => undefined)
    throw error
  }
  const deadline = block.startedAt + start.jobMinutes * 60_000
  const tokenUntil = tokenExpiry(block.stopBy, deadline)
  record = await updateSessionRecord(
    id,
    (current) => ({
      ...current,
      deadline,
      block: block.block,
      blockStartedAt: block.startedAt,
      startedAt: block.startedAt,
      endsAt: block.endsAt,
      stopBy: block.stopBy,
      tokenUntil,
    }),
    { fetcher, clock },
  )
  await renewLease(record, block.stopBy + LEASE_SLACK_MS, clock(), fetcher).catch(() => undefined)
  let started: Awaited<ReturnType<typeof startHostedComputer>>
  try {
    const runToken = mintHostedRunToken({ account, session: id, source: input.source, iat: clock(), exp: tokenUntil })
    started = await startHostedComputer(
      account,
      { computer, session: id, size: start.size, deadline, runToken, diskDays: diskDays(start.caps) },
      options,
    )
  } catch (error) {
    // The provider did not start it (or not that we know of): nothing ran on the hold, so nothing is charged. Should a
    // computer have started anyway, the reconciler stops it, since its session holds no block any more.
    await failSession(record, block.startedAt, options).catch(() => undefined)
    throw error
  }
  try {
    await bootHostedComputer(account, { computer, session: id, runHost: started.runHost }, options)
  } catch (error) {
    // The computer ran: it is stopped and its minutes are charged, as every minute a computer runs is (M8).
    await endHostedSession(record, "failed", options).catch(() => undefined)
    throw error
  }
  record = await updateSessionRecord(
    id,
    (current) =>
      current.state === "starting"
        ? { ...current, state: "running", runningAt: clock(), viewerUrl: started.viewerUrl }
        : undefined,
    { fetcher, clock },
  )
  return sessionView(record)
}

/** A start that failed before any block was held: the lease and the record go, nothing was charged. */
async function abandonSession(record: SessionRecord, fetcher: typeof fetch, clock: () => number) {
  await releaseLease(record, fetcher).catch(() => undefined)
  await updateSessionRecord(
    record.id,
    (current) => ({ ...current, state: "ended", reason: "failed", endedAt: clock() }),
    { fetcher, clock },
  ).catch(() => undefined)
  await store(["ZREM", hostedLiveKey(), record.id], fetcher).catch(() => undefined)
  await store(["DEL", hostedJobKey(record.id)], fetcher).catch(() => undefined)
}

/** A start whose computer did not start: its block is closed at its own start (nothing charged), and it ends. */
async function failSession(record: SessionRecord, endedAt: number, options: SessionOptions) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  await closeBlock(record.account, { session: record.id, block: record.block, endedAt }, { fetcher, clock })
  await stopHostedComputer(record.account, record.computer, options).catch(() => undefined)
  await finishEnd(record.id, "failed", options)
}

// ── Stopping ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ends a session: marks it stopping (with why), stops its computer (its disk is saved), closes its block at the moment
 * the computer stopped (so exactly what ran is charged), gives back its computer's lease and ends it. A provider that
 * cannot stop the computer leaves the session stopping, and the reaper tries again every minute; once the session is
 * `STOP_GIVE_UP_MS` past its stopBy its block has lapsed and been charged in full, so the session ends anyway. Answers
 * the record as it is now.
 */
export async function endHostedSession(
  record: SessionRecord,
  reason: Hosted.EndReason,
  options: SessionOptions = {},
): Promise<SessionRecord> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  let current = await updateSessionRecord(
    record.id,
    (value) =>
      value.state === "ended" || value.state === "stopping"
        ? undefined
        : { ...value, state: "stopping", reason, takeover: undefined },
    { fetcher, clock },
  )
  if (current.state === "ended") return current
  if (current.stoppedAt === undefined) {
    const now = clock()
    let stoppedAt = now
    try {
      await stopHostedComputer(current.account, current.computer, options)
    } catch (error) {
      if (now < current.stopBy + STOP_GIVE_UP_MS) throw error
      stoppedAt = Math.min(now, current.stopBy)
    }
    current = await updateSessionRecord(
      current.id,
      (value) => (value.stoppedAt === undefined ? { ...value, stoppedAt } : undefined),
      { fetcher, clock },
    )
  }
  await closeBlock(
    current.account,
    { session: current.id, block: current.block, endedAt: current.stoppedAt! },
    { fetcher, clock },
  )
  return finishEnd(current.id, current.reason ?? reason, options)
}

async function finishEnd(id: string, reason: Hosted.EndReason, options: SessionOptions) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const now = clock()
  const ended = await updateSessionRecord(
    id,
    (value) =>
      value.state === "ended"
        ? undefined
        : {
            ...value,
            state: "ended",
            reason: value.reason ?? reason,
            endedAt: now,
            stoppedAt: value.stoppedAt ?? now,
            takeover: undefined,
          },
    { fetcher, clock },
  )
  await releaseLease(ended, fetcher).catch(() => undefined)
  await store(["ZREM", hostedLiveKey(), id], fetcher)
  await store(["DEL", hostedJobKey(id), hostedBeatKey(id), hostedModelKey(id)], fetcher).catch(() => undefined)
  await store(["ZADD", hostedRecentKey(), now, ended.account], fetcher).catch(() => undefined)
  // The nightly true-up looks at sessions that ended since its last pass.
  await store(["ZADD", hostedTrueUpKey(ended.account), now, id], fetcher).catch(() => undefined)
  return ended
}

/** Sessions of `account` that ended and wait for the nightly true-up (ZSET sid → when it ended). */
export const hostedTrueUpKey = (account: string) => codiumKey("hosted", "trueup", account)

/**
 * Tells a session to wrap up by `wrapBy` (never later than its hold allows), for `reason`. A session already wrapping
 * keeps the earlier time. Control goes back to the agent so it can save its work.
 */
export async function wrapHostedSession(
  record: SessionRecord,
  wrapBy: number,
  reason: Hosted.EndReason,
  options: SessionOptions = {},
) {
  const at = Math.min(wrapBy, record.stopBy)
  return updateSessionRecord(
    record.id,
    (value) => {
      if (value.state === "wrapping") return value.wrapBy !== undefined && value.wrapBy <= at ? undefined : { ...value, wrapBy: at }
      if (value.state !== "running" && value.state !== "takeover" && value.state !== "starting") return undefined
      return { ...value, state: "wrapping", wrapBy: at, reason, takeover: undefined }
    },
    options,
  )
}

// ── Block renewal (the reaper) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Holds a session's next block (WP A51's `openBlock` with `renew`), renews its computer's lease and gives its computer
 * a run token for the new block. Throws the ledger's refusal when the block cannot be held.
 */
export async function renewHostedBlock(record: SessionRecord, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const block = await openBlock(
    record.account,
    { session: record.id, size: record.size, renew: record.block },
    { fetcher, clock },
  )
  const next = await updateSessionRecord(
    record.id,
    (value) => ({ ...value, block: block.block, blockStartedAt: block.startedAt, endsAt: block.endsAt, stopBy: block.stopBy }),
    { fetcher, clock },
  )
  await renewLease(next, block.stopBy + LEASE_SLACK_MS, clock(), fetcher).catch(() => undefined)
  return refreshRunToken(next, options).catch(() => next)
}

/** Gives the session's computer a fresh run token, valid until a little after its current block's stopBy. */
export async function refreshRunToken(record: SessionRecord, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const tokenUntil = tokenExpiry(record.stopBy, record.deadline)
  const now = clock()
  if (tokenUntil <= now) return record
  const runToken = mintHostedRunToken({
    account: record.account,
    session: record.id,
    source: record.source,
    iat: now,
    exp: Math.min(tokenUntil, now + 60 * 60_000),
  })
  await setHostedRunToken(record.account, { computer: record.computer, runToken }, options)
  return updateSessionRecord(record.id, (value) => ({ ...value, tokenUntil }), { fetcher, clock })
}

// ── The person's actions ───────────────────────────────────────────────────────────────────────────────────────────

/** `account`'s session `id`, or 404 (a session of another account is not found either). */
export async function requireOwnSession(account: string, id: unknown, fetcher: typeof fetch = fetch) {
  if (typeof id !== "string" || !Hosted.SESSION_ID.test(id)) throw notFound()
  const record = await readSessionRecord(id, fetcher)
  if (!record || record.account !== account) throw notFound()
  return record
}

/** The account's sessions, newest first (at most 50), with live ones first. */
export async function listHostedSessions(account: string, fetcher: typeof fetch = fetch) {
  const ids = await store(["ZREVRANGE", hostedSessionsKey(account), 0, 49], fetcher)
  const views: Hosted.SessionView[] = []
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string") continue
    const record = await readSessionRecord(id, fetcher)
    if (record && record.account === account) views.push(sessionView(record))
  }
  return views.sort(
    (a, b) => Number(b.state !== "ended") - Number(a.state !== "ended") || b.createdAt - a.createdAt,
  )
}

/** The person stops a session. Idempotent: an ended session is answered as it is. */
export async function stopHostedSession(account: string, id: unknown, options: SessionOptions = {}) {
  const record = await requireOwnSession(account, id, options.fetcher)
  if (record.state === "ended") return sessionView(record)
  try {
    return sessionView(await endHostedSession(record, "stopped", options))
  } catch {
    // The provider did not answer: the session stays stopping and the reaper finishes the stop.
    const current = await readSessionRecord(record.id, options.fetcher)
    return sessionView(current ?? record)
  }
}

/**
 * The person takes control (at most `Hosted.TAKEOVER_MS` at a time): the agent is paused, since the gateway refuses the
 * session's model requests while it lasts (409 HOSTED_SESSION_PAUSED), and the computer stops recording.
 */
export async function takeOverHostedSession(account: string, id: unknown, options: SessionOptions = {}) {
  const clock = options.clock ?? Date.now
  const record = await requireOwnSession(account, id, options.fetcher)
  const now = clock()
  const next = await updateSessionRecord(
    record.id,
    (value) => {
      if (value.state === "takeover") return undefined
      if (value.state !== "running") throw notRunning(value)
      return { ...value, state: "takeover", takeover: { since: now, until: now + Hosted.TAKEOVER_MS } }
    },
    options,
  )
  return sessionView(next)
}

/** The person gives control back to the agent. */
export async function releaseHostedSession(account: string, id: unknown, options: SessionOptions = {}) {
  const clock = options.clock ?? Date.now
  const record = await requireOwnSession(account, id, options.fetcher)
  const next = await updateSessionRecord(
    record.id,
    (value) =>
      value.state === "takeover" ? { ...value, state: "running", takeover: undefined, releasedAt: clock() } : undefined,
    options,
  )
  return sessionView(next)
}

/**
 * A live view link for the person: the computer's viewer address with a single-use, five-minute viewer token in its
 * fragment. `control` only while the person holds a take-over.
 */
export async function issueViewer(account: string, id: unknown, mode: unknown, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (mode !== "view" && mode !== "control") throw request("Choose view or control.")
  const record = await requireOwnSession(account, id, fetcher)
  if (!["running", "takeover", "wrapping"].includes(record.state) || !record.viewerUrl) throw notRunning(record)
  if (mode === "control" && record.state !== "takeover")
    throw new ApiError(409, "HOSTED_TAKEOVER_REQUIRED", "Take over the computer before you control it.")
  const now = clock()
  const minted = mintViewerToken({
    session: record.id,
    computer: computerName(account, record.computer),
    mode,
    now,
  })
  const recorded = await store(
    ["SET", hostedViewerKey(minted.claims.jti), record.id, "NX", "PX", Hosted.VIEWER_TOKEN_MS],
    fetcher,
  )
  if (recorded !== "OK") throw unavailable()
  const base = record.viewerUrl.replace(/#.*$/, "")
  return {
    url: `${base}#${Hosted.VIEWER_FRAGMENT}=${minted.token}`,
    mode,
    expiresAt: minted.claims.exp * 1000,
  }
}

// ── Files ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a session's packed files live in the media bucket. */
export function archiveKey(account: string, id: string) {
  return `hosted/${stripeMode()}/${hostedAccount(account).slice(0, 32)}/${id}/files.tar.gz`
}

function publicOrigin() {
  try {
    return new URL(process.env.VECTOR_PUBLIC_URL || "https://vectordev.ai").origin
  } catch {
    return "https://vectordev.ai"
  }
}

/**
 * The person asks for a session's files. Once the computer has packed and uploaded them, the answer is a link valid
 * `Hosted.DOWNLOAD_LINK_MS` (`{ready: true, url, expiresAt}`); before that, a running session is asked to pack them
 * (`{ready: false}`) and the person asks again. An ended session whose files were never packed has none to give.
 */
export async function requestDownload(account: string, id: unknown, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (!r2Configured("media")) throw unavailable()
  const record = await requireOwnSession(account, id, fetcher)
  const now = clock()
  if (record.download?.readyAt !== undefined) {
    const link = mintDownloadToken({ session: record.id, now })
    return {
      ready: true as const,
      url: `${publicOrigin()}/api/hosted/sessions/${record.id}/download?t=${link.token}`,
      expiresAt: link.expiresAt,
    }
  }
  if (!["running", "takeover", "wrapping"].includes(record.state))
    throw new ApiError(409, "HOSTED_DOWNLOAD_UNAVAILABLE", "This session's files were not saved for download.")
  await updateSessionRecord(
    record.id,
    (value) => (value.download ? undefined : { ...value, download: { requestedAt: now } }),
    { fetcher, clock },
  )
  return { ready: false as const }
}

/** A 15-minute signed link to a session's packed files, for a valid download link (no sign-in: the link is the key). */
export async function downloadRedirect(id: string, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const record = await readSessionRecord(id, fetcher)
  if (!record || record.download?.readyAt === undefined) throw notFound()
  const key = archiveKey(record.account, id)
  const head = presignR2("media", { method: "HEAD", key, expiresIn: 60, now: clock() })
  const found = await fetcher(head.url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(
    () => undefined,
  )
  if (!found?.ok) throw new ApiError(410, "HOSTED_DOWNLOAD_UNAVAILABLE", "This session's files are no longer kept.")
  return presignR2("media", {
    method: "GET",
    key,
    expiresIn: 900,
    now: clock(),
    response: {
      contentType: "application/gzip",
      cacheControl: "private, no-store",
      contentDisposition: `attachment; filename="vector-cloud-computer-${id}.tar.gz"`,
    },
  }).url
}

// ── The computer's side (the run-API host) ─────────────────────────────────────────────────────────────────────────

/**
 * The run token of a request to the computer's own endpoints (the heartbeat): no browser headers (S7), a valid `vht_`
 * token, run tokens of the account not revoked, and the account not revoked. Account tokens and sessions get 401: these
 * endpoints are the computer's only (S3).
 */
export async function requireHostedRunRequest(
  request: Pick<ApiRequest, "headers">,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<HostedRunClaims> {
  refuseBrowserShaped(request.headers)
  const header = request.headers.authorization
  const bearer = /^Bearer\s+(\S+)$/i.exec((Array.isArray(header) ? header[0] : header) ?? "")?.[1]
  if (!bearer || !bearer.startsWith("vht_"))
    throw new ApiError(401, "MODEL_PLAN_RUN_EXPIRED", "This run is no longer authorized. Save your work and finish the run.")
  const claims = readHostedRunToken(bearer, now)
  if (await runTokenRevoked(claims.account, claims.iat, fetcher))
    throw new ApiError(401, "MODEL_PLAN_RUN_EXPIRED", "This run is no longer authorized. Save your work and finish the run.")
  await requireUnrevokedAccount(claims.account, fetcher)
  return claims
}

/**
 * The gateway's `vht_` verifier (§4.8 `registerRunVerifier`): a valid token for a session of the same account that is
 * not stopping or ended. The gateway then refuses model requests while the session is not live
 * (`assertHostedSessionLive`).
 */
export async function verifyHostedRunToken(token: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const claims = readHostedRunToken(token, now)
  if (await runTokenRevoked(claims.account, claims.iat, fetcher))
    throw new ApiError(401, "MODEL_PLAN_RUN_EXPIRED", "This run is no longer authorized. Save your work and finish the run.")
  const record = await readSessionRecord(claims.session, fetcher)
  if (!record || record.account !== claims.account || record.state === "ended" || record.state === "stopping")
    throw new ApiError(401, "MODEL_PLAN_RUN_EXPIRED", "This run is no longer authorized. Save your work and finish the run.")
  return {
    account: { id: claims.account },
    kind: "run" as const,
    purpose: "hosted" as const,
    run: {
      id: claims.session,
      source: claims.source,
      deadline: claims.exp,
      service: "hosted" as const,
      sessionId: claims.session,
    },
  }
}

/**
 * Whether a session's agent may make a model request now (§4.8 `assertHostedSessionLive`): the session is starting,
 * running or wrapping (not under the person's control, not stopping or ended), its current block still holds its time,
 * and its deadline has not passed by more than the provider's grace.
 */
export async function assertHostedSessionLive(sessionId: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const record = await readSessionRecord(sessionId, fetcher)
  if (!record) return false
  return (
    (record.state === "starting" || record.state === "running" || record.state === "wrapping") &&
    now < record.stopBy &&
    now < record.deadline + TIMEOUT_GRACE_MS
  )
}

/** Records the session's last model request (the gateway's `afterSettle`), for the idle and fair-use checks. */
export async function recordHostedModelRequest(sessionId: string, at: number, fetcher: typeof fetch = fetch) {
  if (!Hosted.SESSION_ID.test(sessionId)) return
  await store(["SET", hostedModelKey(sessionId), String(at), "PX", 2 * DAY_MS], fetcher)
}

export type Beat = {
  at: number
  activeAt?: number
  cpu?: number
  busySince?: number
  pageLoads: number
  egressBytes: number
  booted: boolean
  done: boolean
  archiveBytes?: number
  /** The base image generation the computer's disk was made from (WP A54). */
  generation?: number
  /** The latest hand-over to the person the daemon reported, and since when (WP A54). */
  handoff?: { reason: Hosted.Handoff; since: number }
}

/** The daemon's last report for a session, or undefined. */
export async function readBeat(id: string, fetcher: typeof fetch = fetch): Promise<Beat | undefined> {
  const raw = await store(["GET", hostedBeatKey(id)], fetcher)
  if (typeof raw !== "string") return undefined
  try {
    const value = JSON.parse(raw) as Beat
    return Number.isFinite(value.at) ? value : undefined
  } catch {
    return undefined
  }
}

/** The session's last model request (ms), or undefined. */
export async function readModelRequest(id: string, fetcher: typeof fetch = fetch) {
  const raw = await store(["GET", hostedModelKey(id)], fetcher)
  const at = Number(raw)
  return raw !== null && raw !== undefined && Number.isSafeInteger(at) ? at : undefined
}

function count(value: unknown, max: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined
}

/** The heartbeat's body, checked: unknown or malformed fields are dropped, never trusted. */
export function parseHeartbeat(input: unknown): Hosted.Heartbeat {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw request()
  const body = input as Record<string, unknown>
  const cpu = typeof body.cpu === "number" && Number.isFinite(body.cpu) && body.cpu >= 0 && body.cpu <= 100 ? body.cpu : undefined
  const activeAt = count(body.activeAt, Number.MAX_SAFE_INTEGER)
  const pageLoads = count(body.pageLoads, 10_000_000)
  const egressBytes = count(body.egressBytes, Number.MAX_SAFE_INTEGER)
  const archiveBytes = count(body.archiveBytes, ARCHIVE_MAX_BYTES)
  const generation = count(body.generation, 1_000_000)
  const handoff = Hosted.HANDOFFS.find((reason) => reason === body.handoff)
  return {
    ...(cpu !== undefined ? { cpu } : {}),
    ...(activeAt !== undefined ? { activeAt } : {}),
    ...(pageLoads !== undefined ? { pageLoads } : {}),
    ...(egressBytes !== undefined ? { egressBytes } : {}),
    ...(body.booted === true ? { booted: true } : {}),
    ...(body.done === true ? { done: true } : {}),
    ...(archiveBytes !== undefined && archiveBytes > 0 ? { archiveBytes } : {}),
    ...(body.uploaded === true ? { uploaded: true } : {}),
    ...(generation !== undefined && generation > 0 ? { generation } : {}),
    ...(handoff ? { handoff } : {}),
  }
}

export function utcDay(at: number) {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Something a later package adds to a running session's heartbeat answer (WP A55: Done by Morning's recording links).
 * It gets the session, the daemon's raw report (fields this module does not know are its to read) and the answer to
 * add to. A hook that fails is skipped: the heartbeat itself never fails because of one.
 */
export type HostedHeartbeatHook = (context: {
  record: SessionRecord
  input: unknown
  answer: Hosted.HeartbeatAnswer
  now: number
  fetcher: typeof fetch
  clock: () => number
}) => Promise<void>
const heartbeatHooks = new Map<string, HostedHeartbeatHook>()

/** Registers a heartbeat hook once per id, by static import from the heartbeat's route (hosted-jobs-runtime.ts). */
export function registerHostedHeartbeatHook(id: string, hook: HostedHeartbeatHook) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || heartbeatHooks.has(id))
    throw new Error("A hosted heartbeat hook must have one unique id.")
  heartbeatHooks.set(id, hook)
}
export function utcHour(at: number) {
  return new Date(at).toISOString().slice(0, 13)
}

/**
 * The computer's daemon reports (`POST /api/hosted/sessions/<id>/heartbeat` on the run-API host, with the session's run
 * token): its CPU, its agent's last activity, page loads and egress (cumulative), whether it booted, finished or packed
 * the files the person asked for. The answer tells it the session's state, who has control, its deadline, whether the
 * browser may be used, the viewer tokens' key and, until it booted, its job.
 */
export async function recordHeartbeat(
  claims: HostedRunClaims,
  id: string,
  input: unknown,
  options: SessionOptions = {},
): Promise<Hosted.HeartbeatAnswer> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (claims.session !== id) throw new ApiError(403, "HOSTED_RUN_REFUSED", "This run token is for another session.")
  const record = await readSessionRecord(id, fetcher)
  if (!record || record.account !== claims.account) throw notFound()
  const beat = parseHeartbeat(input)
  const now = clock()
  const answer: Hosted.HeartbeatAnswer = {
    state: record.state,
    control: record.state === "takeover" ? "person" : "agent",
    deadline: record.deadline,
    ...(record.state === "wrapping" && record.wrapBy !== undefined ? { wrapBy: record.wrapBy } : {}),
    browser: record.browser,
    viewerKey: viewerPublicKey(),
  }
  if (record.state === "ended" || record.state === "stopping") return answer
  const previous = await readBeat(id, fetcher)
  const pageLoads = beat.pageLoads ?? previous?.pageLoads ?? 0
  const egressBytes = beat.egressBytes ?? previous?.egressBytes ?? 0
  // A counter that went down means the daemon restarted: what it reports now is all new.
  const pagesDelta = pageLoads >= (previous?.pageLoads ?? 0) ? pageLoads - (previous?.pageLoads ?? 0) : pageLoads
  const egressDelta =
    egressBytes >= (previous?.egressBytes ?? 0) ? egressBytes - (previous?.egressBytes ?? 0) : egressBytes
  if (pagesDelta > 0) {
    const key = hostedPagesKey(record.account, utcHour(now))
    await store(["INCRBY", key, pagesDelta], fetcher)
    await store(["PEXPIRE", key, 2 * 3_600_000], fetcher)
  }
  if (egressDelta > 0) {
    const key = hostedEgressKey(record.account, utcDay(now))
    await store(["INCRBY", key, egressDelta], fetcher)
    await store(["PEXPIRE", key, 2 * DAY_MS], fetcher)
  }
  const busy = beat.cpu !== undefined && beat.cpu >= 80
  const activeAt = Math.max(
    previous?.activeAt ?? 0,
    beat.activeAt !== undefined ? Math.min(Math.max(beat.activeAt, record.createdAt), now) : 0,
  )
  const next: Beat = {
    at: now,
    ...(activeAt > 0 ? { activeAt } : {}),
    ...(beat.cpu !== undefined ? { cpu: beat.cpu } : {}),
    ...(busy ? { busySince: previous?.busySince ?? now } : {}),
    pageLoads,
    egressBytes,
    booted: Boolean(previous?.booted || beat.booted),
    done: Boolean(previous?.done || beat.done),
    ...(beat.archiveBytes !== undefined ? { archiveBytes: beat.archiveBytes } : previous?.archiveBytes !== undefined ? { archiveBytes: previous.archiveBytes } : {}),
    ...(beat.generation !== undefined ? { generation: beat.generation } : {}),
    ...(beat.handoff
      ? { handoff: { reason: beat.handoff, since: previous?.handoff?.reason === beat.handoff ? previous.handoff.since : now } }
      : {}),
  }
  await store(
    ["SET", hostedBeatKey(id), JSON.stringify(next), "PX", Math.max(60_000, record.deadline + TIMEOUT_GRACE_MS + DAY_MS - now)],
    fetcher,
  )
  if (!next.booted) {
    const job = await store(["GET", hostedJobKey(id)], fetcher)
    if (typeof job === "string") {
      try {
        const value = JSON.parse(job) as { prompt?: unknown; title?: unknown }
        if (typeof value.prompt === "string")
          answer.job = { prompt: value.prompt, ...(typeof value.title === "string" ? { title: value.title } : {}) }
      } catch {}
    }
  } else if (beat.booted) await store(["DEL", hostedJobKey(id)], fetcher)
  const download = record.download
  if (download && download.readyAt === undefined && r2Configured("media")) {
    const key = archiveKey(record.account, id)
    if (beat.uploaded && next.archiveBytes !== undefined) {
      const head = presignR2("media", { method: "HEAD", key, expiresIn: 60, now })
      const found = await fetcher(head.url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(
        () => undefined,
      )
      if (found?.ok && Number(found.headers.get("content-length")) === next.archiveBytes)
        await updateSessionRecord(
          id,
          (value) =>
            value.download && value.download.readyAt === undefined
              ? { ...value, download: { ...value.download, readyAt: now, bytes: next.archiveBytes } }
              : undefined,
          { fetcher, clock },
        )
    } else if (next.archiveBytes === undefined) {
      // The person asked for the files and the computer has not packed them yet (WP A54).
      answer.pack = true
    } else {
      const put = presignR2("media", {
        method: "PUT",
        key,
        contentLength: next.archiveBytes,
        contentType: "application/gzip",
        expiresIn: 900,
        now,
      })
      answer.upload = { url: put.url, headers: put.headers, expiresAt: put.expiresAt }
    }
  }
  for (const hook of heartbeatHooks.values())
    await hook({ record, input, answer, now, fetcher, clock }).catch(() => undefined)
  return answer
}

// ── Status and computers ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the person's surfaces show about the cloud computer (`GET /api/hosted/status`): whether it can be used here, what
 * the plan's state lets it do now, the plan's public caps (with the trust ramp), the share of this month's hours used
 * and the live sessions. Shares, counts and times only (P1). Reads the snapshot (no Stripe call while it is fresh, M4).
 */
export async function hostedStatus(account: string, snapshot: EntitlementSnapshot | undefined, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const now = clock()
  const [service, open, suspension] = await Promise.all([
    readSwitch("hosted", fetcher, { now }),
    hostedOpen(account, fetcher),
    readSuspension(account, fetcher),
  ])
  const configured = hostedSessionsConfigured(options)
  const caps = snapshot ? hostedCaps(snapshot, now) : null
  const access = hostedAccess(snapshot, service === "off" ? "stop" : service, now)
  const sessions = (await listHostedSessions(account, fetcher)).filter((session) => session.state !== "ended")
  const hours = caps && snapshot ? await hoursUsedShare(snapshot, fetcher, now).catch(() => undefined) : undefined
  return {
    available: configured && open && service === "on",
    access: suspension ? ("stop" as const) : access,
    ...(suspension ? { onHold: true } : {}),
    ...(caps && snapshot
      ? {
          plan: {
            computers: caps.computers,
            hours: caps.hours,
            jobMinutes: caps.jobMin,
            diskDays: caps.diskDays,
            sizes: [...caps.sizes],
            browser: hostedBrowserAllowed(snapshot, now),
            ...(snapshot.ramp.hostedUntil > now ? { rampUntil: snapshot.ramp.hostedUntil } : {}),
          },
        }
      : {}),
    ...(hours !== undefined ? { hours: { used: hours } } : {}),
    sessions,
  }
}

/** The account's computers: which are running a session, and when their disks are deleted if a deletion is set. */
export async function hostedComputers(account: string, snapshot: EntitlementSnapshot | undefined, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const now = clock()
  const known = await store(["SMEMBERS", hostedComputersKey(account)], fetcher)
  const numbers = new Set(
    (Array.isArray(known) ? known : []).map(Number).filter((value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_COMPUTERS),
  )
  const caps = snapshot ? hostedCaps(snapshot, now) : null
  for (let n = 1; n <= (caps?.computers ?? 0); n++) numbers.add(n)
  const leases = await readLeases(account, fetcher, now)
  const deletion = Number(await store(["ZSCORE", hostedDiskDueKey(), account], fetcher))
  return {
    computers: [...numbers]
      .sort((a, b) => a - b)
      .map((computer) => ({
        computer,
        running: leases.has(computer),
        ...(leases.has(computer) ? { session: leases.get(computer)! } : {}),
        included: caps !== null && computer <= caps.computers,
      })),
    ...(Number.isSafeInteger(deletion) && deletion > 0 ? { disksDeletedAt: deletion } : {}),
  }
}

/** Accounts whose computers' disks are to be deleted, scored by when (§4.4's ended and lost-dispute retention). */
export const hostedDiskDueKey = () => codiumKey("hosted", "disk-due")

/** The person deletes one of their computers and its saved disk. Refused while a session runs on it. */
export async function eraseHostedComputer(account: string, computer: unknown, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (typeof computer !== "number" || !Number.isSafeInteger(computer) || computer < 1 || computer > MAX_COMPUTERS)
    throw request("Choose one of your computers.")
  const leases = await readLeases(account, fetcher, clock())
  if (leases.has(computer))
    throw new ApiError(409, "HOSTED_SESSION_RUNNING", "A session is running on this computer. Stop it first.")
  const result = await destroyHostedComputer(account, computer, options)
  const name = computerName(account, computer)
  await store(["SREM", hostedComputersKey(account), computer], fetcher)
  await store(["HDEL", hostedNamesKey(), name], fetcher)
  return { computer, deleted: result === "deleted" }
}

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function request(message = "This cloud computer request is not valid.") {
  return new ApiError(400, "HOSTED_REQUEST", message)
}

function notFound() {
  return new ApiError(404, "HOSTED_SESSION_NOT_FOUND", "This cloud computer session was not found.")
}

function notRunning(record: SessionRecord) {
  return new ApiError(409, "HOSTED_SESSION_ENDED", "This cloud computer session is not running.", {
    detail: { state: record.state },
  })
}
