import { createHash, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import { ENTITLEMENTS, type EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { PLANS, type PlanId } from "../../packages/schema/src/codium-plan.js"
import { ENABLED_SOURCES, RUN_SOURCES, type RunTrigger } from "../../packages/schema/src/codium-run-trigger.js"
import { Hosted } from "../../packages/schema/src/hosted.js"
import type { Transition } from "./codium-provision.js"
import { codiumKey } from "./codium-keys.js"
import { listedPerks } from "./codium-perks.js"
import { readSnapshot } from "./codium-snapshot.js"
import { readSwitch } from "./codium-switches.js"
import { hostedAccess, hostedAllowedAccounts, hostedCaps, hostedSnapshot, unavailable } from "./hosted-entitlement.js"
import { hostedAccount } from "./hosted-ledger.js"
import {
  HOSTED_SESSION_SCRIPTS,
  hostedSessionsConfigured,
  hostedSessionsKey,
  readSessionRecord,
  readSuspension,
  startHostedSession,
  stopHostedSession,
  utcDay,
  type SessionOptions,
  type SessionRecord,
} from "./hosted-sessions.js"
import type { HostedRunClaims } from "./hosted-tokens.js"
import { ApiError } from "./http.js"
import type { ModelPlanCatalogOptions } from "./model-plan-catalog-policy.js"
import { servedJudges } from "./model-plan-models.js"
import { stripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"
import { presignR2, r2Configured } from "./r2-presign.js"
import { SafeFetchError, safeUrl } from "./safe-fetch.js"
import { sendServerAlert } from "./web-push.js"

/*
 * Done by Morning (contract WP A55): jobs queued before bed with success criteria, run one session each on the person's
 * cloud computer (WP A53), and ended by a report that a model from another lab checked against each criterion.
 *
 * One entry. Every job, whoever queues it (the desktop, the phone, the CLI, a recurring job's run), comes in through
 * `enqueueHostedJob(trigger)` (§4.17). The plan's caps come from the snapshot only (S1): jobs a night and recurring jobs
 * a day are counted when a job is queued, atomically with the job; jobs at once and the plan's hours when it starts.
 *
 * The plan's states (§4.4's Done by Morning row): active runs the queue; renewing lets started jobs continue and starts
 * none; paused (a failed payment) pauses the queue; ended, a plan without Done by Morning and a dispute (frozen) cancel
 * it; account deletion erases it (P5).
 *
 * Money. A job's session is an ordinary cloud computer session: its time is held before it runs and charged into the
 * pool at no less than cost (M8, WP A51). Recordings and reports cost Vector a few cents (contract §1.4).
 *
 * Honesty. A job aims to deliver by its time and promises nothing (H3): one that cannot start before that time is
 * missed, never started late. The second lab's pass or fail is claimed only when the server picked a judge from a lab
 * the session's own model requests did not use and saw the session ask that judge after it reported. Anything that
 * would go live waits as a pull request the person approves: the server opens nothing, merges nothing and writes to no
 * repository (S9). Approve answers the pull request's address for the person's own client to open.
 *
 * Recordings. A job's session uploads the last `Hosted.RECORDING_SEGMENTS` one-minute segments of its screen as it
 * runs (into as many rotating slots in the media bucket), so a session that ends abruptly still has them. Only the
 * job's owner gets links to them, for `Hosted.RECORDING_DAYS` days after the job ended; the bucket's lifecycle rule on
 * `recordings/` deletes them after 31 (owner step).
 *
 * Store keys (all under the Codium prefix; §4.6 names `hosted:jobs:due`, the rest are this package's):
 * - `hosted:jobs:due`                     ZSET job id → when it may start;
 * - `hosted:jobs:item:<job>`              the job record (JSON, compare-and-set), kept 35 days after it ends;
 * - `hosted:jobs:account:<account>`       ZSET of the account's jobs by when they were queued;
 * - `hosted:jobs:live`                    ZSET of running jobs (the runner checks their sessions);
 * - `hosted:jobs:running:<account>`       SET of the account's running jobs (jobs at once);
 * - `hosted:jobs:session:<session>`       the job a session runs;
 * - `hosted:jobs:claim:<job>`             a start in progress (2 minutes);
 * - `hosted:jobs:night:<account>:<date>`  jobs queued for the night whose deliver-by time falls on that UTC date;
 * - `hosted:jobs:rday:<account>:<date>`   recurring jobs' runs queued for that UTC date;
 * - `hosted:jobs:recurring:<account>`     HASH recurring job id → definition; `hosted:jobs:recurring-due` ZSET of
 *                                         `<account>:<id>` → its next run;
 * - `hosted:jobs:rec:<job>`               HASH recording slot → `<segment>:<bytes>:<p|u>:<at>`;
 * - `hosted:jobs:models:<session>`        HASH of the models a hosted session's requests used (`c:`, `t:`, `l:`).
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ACCOUNT = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
/** A job record is kept this long after it ends (its recording's 30 days, and the report). */
export const JOB_KEEP_MS = 35 * DAY
/** The account's index keeps jobs queued in this window, long enough to find every recording at deletion. */
const ACCOUNT_INDEX_MS = 40 * DAY
/** A start in progress holds its job this long. */
const CLAIM_MS = 2 * MINUTE
/** A running job whose session never got linked (a store fault mid-start) is given up after this long. */
const START_LINK_MS = 10 * MINUTE
/** A recurring run more than this late (the queue was waiting) is skipped, not queued. */
const RECURRING_LATE_MS = 2 * HOUR
/** A recurring run aims to deliver this long after its job's minutes. */
const RECURRING_SLACK_MS = HOUR
/** The session-models log lives this long. */
const MODELS_KEEP_MS = 2 * DAY
/** At most this many jobs, recurring runs and running jobs are looked at per pass. */
const PASS_MAX = 25

export type JobOptions = SessionOptions & {
  /** The served catalog for picking judges (tests pass a qualifier; production uses accepted routes). */
  catalog?: ModelPlanCatalogOptions
  /** Sends the title-only phone alert when a job ends (default: `sendServerAlert`). */
  alert?: (account: string, alert: { title: string; tag: string }) => Promise<unknown>
}

// ── Store keys ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const hostedJobsDueKey = () => codiumKey("hosted", "jobs", "due")
export const hostedJobKey = (id: string) => codiumKey("hosted", "jobs", "item", id)
export const hostedJobsAccountKey = (account: string) => codiumKey("hosted", "jobs", "account", account)
export const hostedJobsLiveKey = () => codiumKey("hosted", "jobs", "live")
export const hostedJobsRunningKey = (account: string) => codiumKey("hosted", "jobs", "running", account)
export const hostedJobSessionKey = (session: string) => codiumKey("hosted", "jobs", "session", session)
export const hostedJobClaimKey = (id: string) => codiumKey("hosted", "jobs", "claim", id)
export const hostedJobsNightKey = (account: string, date: string) => codiumKey("hosted", "jobs", "night", account, date)
export const hostedJobsRecurringDayKey = (account: string, date: string) =>
  codiumKey("hosted", "jobs", "rday", account, date)
export const hostedRecurringKey = (account: string) => codiumKey("hosted", "jobs", "recurring", account)
export const hostedRecurringDueKey = () => codiumKey("hosted", "jobs", "recurring-due")
export const hostedJobRecordingKey = (id: string) => codiumKey("hosted", "jobs", "rec", id)
export const hostedSessionModelsKey = (session: string) => codiumKey("hosted", "jobs", "models", session)

// ── Scripts ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ENQUEUE. Counts a job against its cap and queues it, atomically. KEYS: the counter, the job record, the due set, the
 * account's index. ARGV: the cap, the counter's lifetime (ms), the record, its lifetime (ms), the job id, when it may
 * start, when it was queued. -1 when the job exists already (a recurring run queued twice), 0 when the cap is reached,
 * else the count with this job.
 */
const ENQUEUE = `if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return 0 end
used = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[4])
redis.call('ZADD', KEYS[3], ARGV[6], ARGV[5])
redis.call('ZADD', KEYS[4], ARGV[7], ARGV[5])
return used`

/** REFUND. Gives a cancelled queued job's count back: KEYS[1] the counter, lowered while above 0. Answers the count. */
const REFUND = `local used = tonumber(redis.call('GET', KEYS[1]) or '0') if used > 0 then return redis.call('DECR', KEYS[1]) end return 0`

/**
 * SLOT. Jobs at once: job ARGV[1] takes a place in the account's running set KEYS[1] while it holds fewer than ARGV[2]
 * (a job already there keeps its place); the set lives at least ARGV[3] ms. 1 when it holds one, 0 when all are taken.
 */
const SLOT = `if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 1 end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('SADD', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[3]) then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return 1`

/**
 * RECUR. Saves recurring job ARGV[1] (definition ARGV[2]) in the account's hash KEYS[1] while it holds fewer than ARGV[3]
 * (an existing one is replaced), and schedules member ARGV[4] at ARGV[5] in KEYS[2]. 1 when saved, 0 at the cap.
 */
const RECUR = `if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[4])
return 1`

/** MODELS. Notes one settled request of a hosted session on model ARGV[1] at ARGV[2] (lab ARGV[3]); lives ARGV[4] ms. */
const MODELS = `redis.call('HINCRBY', KEYS[1], 'c:' .. ARGV[1], 1)
redis.call('HSET', KEYS[1], 't:' .. ARGV[1], ARGV[2])
redis.call('HSET', KEYS[1], 'l:' .. ARGV[1], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1`

export const HOSTED_JOB_SCRIPTS = Object.freeze({ ENQUEUE, REFUND, SLOT, RECUR, MODELS })

function store(command: readonly (string | number)[], fetcher: typeof fetch) {
  return persistentStore(command, fetcher)
}

// ── Records ────────────────────────────────────────────────────────────────────────────────────────────────────────

const Link = Schema.Struct({ title: Schema.optional(Schema.String), url: Schema.String })
const Result = Schema.Struct({ pass: Schema.Boolean, note: Schema.optional(Schema.String) })
const Judge = Schema.Struct({ model: Schema.String, lab: Schema.String })
const Report = Schema.Struct({
  summary: Schema.String,
  links: Schema.Array(Link),
  pullRequest: Schema.optional(Schema.String),
  submittedAt: Schema.Number,
  /** The labs the session's own model requests used before it reported. */
  workerLabs: Schema.Array(Schema.String),
  judge: Schema.optional(Judge),
  results: Schema.optional(Schema.Array(Result)),
  judgedAt: Schema.optional(Schema.Number),
})
const JobRecord = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  account: Schema.String,
  source: Schema.Literals(RUN_SOURCES),
  purpose: Schema.String,
  state: Schema.Literals(Hosted.JOB_STATES),
  reason: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  prompt: Schema.String,
  criteria: Schema.Array(Schema.String),
  pages: Schema.optional(Schema.Array(Schema.String)),
  size: Schema.Literals(Hosted.SIZES),
  jobMinutes: Schema.Int,
  deliverBy: Schema.Number,
  startAfter: Schema.Number,
  createdAt: Schema.Number,
  /** The counter this job counted against (night or recurring day), for a refund and for deletion. */
  counter: Schema.String,
  recurring: Schema.optional(Schema.String),
  requestedBy: Schema.optional(Schema.Struct({ platform: Schema.String, userId: Schema.String })),
  /** Why it has not started yet (the queue waiting, paused, every computer busy). */
  waiting: Schema.optional(Schema.String),
  startingAt: Schema.optional(Schema.Number),
  session: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  endedAt: Schema.optional(Schema.Number),
  report: Schema.optional(Report),
  approvedAt: Schema.optional(Schema.Number),
})
export type JobRecord = typeof JobRecord.Type

const decodeJob = Schema.decodeUnknownOption(Schema.fromJsonString(JobRecord))

const Recurring = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  account: Schema.String,
  title: Schema.optional(Schema.String),
  prompt: Schema.String,
  criteria: Schema.Array(Schema.String),
  pages: Schema.Array(Schema.String),
  size: Schema.Literals(Hosted.SIZES),
  jobMinutes: Schema.Int,
  timeOfDay: Schema.Int,
  days: Schema.Array(Schema.Int),
  createdAt: Schema.Number,
})
export type RecurringRecord = typeof Recurring.Type

const decodeRecurring = Schema.decodeUnknownOption(Schema.fromJsonString(Recurring))

function jobKeepMs(record: JobRecord, now: number) {
  const end = record.endedAt ?? Math.max(record.deliverBy, now) + record.jobMinutes * MINUTE
  return Math.max(MINUTE, end + JOB_KEEP_MS - now)
}

/** A job's record, or undefined when there is none (or it cannot be read as one). */
export async function readJobRecord(id: string, fetcher: typeof fetch = fetch) {
  if (!Hosted.JOB_ID.test(id)) return undefined
  const raw = await store(["GET", hostedJobKey(id)], fetcher)
  if (typeof raw !== "string") return undefined
  return Option.getOrUndefined(decodeJob(raw))
}

/**
 * Changes a job record with compare-and-set (WP A53's SAVE): `change` answers the next record, or undefined to leave it.
 * Retried when another writer moved it in between. Answers the record as stored.
 */
export async function updateJobRecord(
  id: string,
  change: (record: JobRecord) => JobRecord | undefined,
  options: { fetcher?: typeof fetch; clock?: () => number } = {},
) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = await store(["GET", hostedJobKey(id)], fetcher)
    if (typeof raw !== "string") throw jobNotFound()
    const current = Option.getOrUndefined(decodeJob(raw))
    if (!current) throw unavailable()
    const next = change(current)
    if (!next) return current
    const saved = await store(
      ["EVAL", HOSTED_SESSION_SCRIPTS.SAVE, 1, hostedJobKey(id), raw, JSON.stringify(next), jobKeepMs(next, clock())],
      fetcher,
    )
    if (Number(saved) === 1) return next
  }
  throw unavailable()
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

function base32(bytes: Uint8Array, length: number) {
  let out = ""
  for (let index = 0; index < length; index++) out += ALPHABET[bytes[index]! & 31]
  return out
}

/** A new job id: `jb_` and 26 base32 letters (130 random bits). */
export function newJobId() {
  return `jb_${base32(randomBytes(26), 26)}`
}

/** A new recurring job id: `jr_` and 26 base32 letters. */
export function newRecurringId() {
  return `jr_${base32(randomBytes(26), 26)}`
}

/** The job id of one run of a recurring job, the same however often it is queued (so it is queued once). */
export function recurringRunId(recurring: string, at: number) {
  return `jb_${base32(createHash("sha256").update(`${recurring}:${at}`).digest(), 26)}`
}

function recordingKey(account: string, job: string, slot: number) {
  return `recordings/${stripeMode()}/${hostedAccount(account).slice(0, 32)}/${job}/slot-${slot}.ts`
}

type Slot = { n: number; bytes: number; state: "p" | "u"; at: number }

function parseSlots(flat: unknown) {
  const slots = new Map<number, Slot>()
  if (!Array.isArray(flat)) return slots
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const slot = Number(flat[index])
    const match = /^(\d+):(\d+):([pu]):(\d+)$/.exec(String(flat[index + 1]))
    if (!match || !Number.isSafeInteger(slot) || slot < 0 || slot >= Hosted.RECORDING_SEGMENTS) continue
    slots.set(slot, { n: Number(match[1]), bytes: Number(match[2]), state: match[3] as "p" | "u", at: Number(match[4]) })
  }
  return slots
}

async function readSlots(job: string, fetcher: typeof fetch) {
  return parseSlots(await store(["HGETALL", hostedJobRecordingKey(job)], fetcher))
}

function recordingUntil(record: JobRecord, now: number) {
  return (record.endedAt ?? now) + Hosted.RECORDING_DAYS * DAY
}

/** A job as its owner sees it: states, times, counts and its own words (P1). */
export function jobView(record: JobRecord, slots?: Map<number, Slot>, now = Date.now()): Hosted.JobView {
  const uploaded = slots ? [...slots.values()].filter((slot) => slot.state === "u").length : 0
  const until = recordingUntil(record, now)
  const report = record.report
  return {
    id: record.id,
    state: record.state,
    ...(record.reason ? { reason: record.reason as Hosted.JobReason } : {}),
    ...(record.title ? { title: record.title } : {}),
    prompt: record.prompt,
    criteria: [...record.criteria],
    ...(record.pages?.length ? { pages: [...record.pages] } : {}),
    size: record.size,
    jobMinutes: record.jobMinutes,
    deliverBy: record.deliverBy,
    startAfter: record.startAfter,
    createdAt: record.createdAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.session ? { session: record.session } : {}),
    ...(record.recurring ? { recurring: record.recurring } : {}),
    ...(report
      ? {
          report: {
            summary: report.summary,
            links: report.links.map((link) => ({ ...(link.title ? { title: link.title } : {}), url: link.url })),
            ...(report.pullRequest ? { pullRequest: report.pullRequest } : {}),
            submittedAt: report.submittedAt,
            judged: report.results !== undefined && report.judge !== undefined,
            ...(report.judge ? { judge: { model: report.judge.model, lab: report.judge.lab } } : {}),
            ...(report.results
              ? {
                  results: report.results.map((result, index) => ({
                    criterion: record.criteria[index] ?? "",
                    pass: result.pass,
                    ...(result.note ? { note: result.note } : {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
    ...(uploaded > 0 && now < until ? { recording: { segments: uploaded, until } } : {}),
    ...(record.approvedAt !== undefined ? { approvedAt: record.approvedAt } : {}),
  }
}

function recurringView(record: RecurringRecord, nextAt: number): Hosted.RecurringView {
  return {
    id: record.id,
    ...(record.title ? { title: record.title } : {}),
    prompt: record.prompt,
    criteria: [...record.criteria],
    pages: [...record.pages],
    size: record.size,
    jobMinutes: record.jobMinutes,
    timeOfDay: record.timeOfDay,
    days: [...record.days],
    createdAt: record.createdAt,
    nextAt,
  }
}

// ── Configuration and the plan ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether Done by Morning can run here: everything a cloud computer session needs (WP A53's provider, ledger and both
 * signing keys) and the media bucket for its recordings. `overnight`'s readiness in the perk listing is this.
 */
export function doneByMorningConfigured(options: Pick<SessionOptions, "provider"> = {}) {
  return hostedSessionsConfigured(options) && r2Configured("media")
}

/** Whether new jobs may be queued or started for `account`: `overnight` listed, or the account on the owner's list. */
export async function hostedJobsOpen(account: string, fetcher: typeof fetch = fetch) {
  if (hostedAllowedAccounts().has(account.toLowerCase())) return true
  return (await listedPerks(fetcher)).has("overnight")
}

type Overnight = NonNullable<EntitlementSnapshot["caps"]["overnight"]>

/** The cheapest plan that includes Done by Morning, for an upgrade hint. */
function overnightPlan(): { plan?: PlanId } {
  const plan = PLANS.find((candidate) => ENTITLEMENTS[candidate.id].overnight !== null)
  return plan ? { plan: plan.id } : {}
}

/**
 * The queue as the person's surfaces show it: `open` while the plan is active and Done by Morning available; `waiting`
 * while a renewal is collected or Vector paused new work; `paused` while a payment is owed; `closed` otherwise.
 */
export function queueState(
  snapshot: EntitlementSnapshot | undefined,
  service: string,
  open: boolean,
  now = Date.now(),
): Hosted.QueueState {
  if (!snapshot?.plan || !snapshot.caps.overnight) return "closed"
  const plan = hostedAccess(snapshot, "on", now)
  if (plan === "stop") return "closed"
  if (plan === "wrap") return "paused"
  if (!open) return "closed"
  if (plan === "continue" || service !== "on") return "waiting"
  return "open"
}

/**
 * The plan's Done by Morning for a person queueing work: the snapshot (WP A51's `hostedSnapshot`, which answers the
 * plan's refusals in the cloud computer's codes), its caps, and its trust-ramped cloud computer caps. A plan without
 * Done by Morning gets 403 HOSTED_NOT_INCLUDED {perk: "overnight"}; a paused plan 402 HOSTED_PAUSED (its queue is paused).
 */
async function requireJobPlan(account: string, options: JobOptions, now: number) {
  const fetcher = options.fetcher ?? fetch
  if (!doneByMorningConfigured(options)) throw unavailable()
  if ((await readSwitch("hosted", fetcher, { now })) !== "on")
    throw new ApiError(503, "HOSTED_UNAVAILABLE", "The cloud computer is not taking new jobs right now. Try again later.")
  if (!(await hostedJobsOpen(account, fetcher)))
    throw new ApiError(503, "HOSTED_UNAVAILABLE", "Done by Morning is not available on Vector yet.")
  const suspension = await readSuspension(account, fetcher)
  if (suspension)
    throw new ApiError(403, "HOSTED_FROZEN", "The cloud computer is on hold for this account. Contact Vector support.", {
      detail: { reason: suspension.reason === "abuse" ? "fair-use" : "owner" },
    })
  const snapshot = await hostedSnapshot(account, fetcher, now)
  const overnight = snapshot.caps.overnight
  if (!overnight)
    throw new ApiError(403, "HOSTED_NOT_INCLUDED", "Your Vector Codium plan does not include Done by Morning.", {
      detail: { perk: "overnight", ...overnightPlan() },
    })
  if (hostedAccess(snapshot, "on", now) === "wrap")
    throw new ApiError(402, "HOSTED_PAUSED", "Your Done by Morning queue is paused until your payment goes through.")
  return { snapshot, overnight: overnight as Overnight, caps: hostedCaps(snapshot, now)! }
}

// ── Checking what a person sends ───────────────────────────────────────────────────────────────────────────────────

function request(message = "This Done by Morning request is not valid.") {
  return new ApiError(400, "HOSTED_REQUEST", message)
}

function oneLine(value: unknown, max: number) {
  if (typeof value !== "string") return undefined
  const text = value.trim().replace(/\s+/g, " ")
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return undefined
  return text
}

/** The job's own words: trimmed, 1 to `Hosted.JOB_PROMPT_MAX` characters, no NUL. */
export function parsePrompt(value: unknown) {
  if (typeof value !== "string") throw request("Say what the job should do.")
  const prompt = value.trim()
  if (!prompt || prompt.length > Hosted.JOB_PROMPT_MAX || prompt.includes("\u0000"))
    throw request("Say what the job should do, in at most 24,000 characters.")
  return prompt
}

/** Success criteria: 1 to `Hosted.CRITERIA_MAX`, each one line of at most `Hosted.CRITERION_MAX` characters. */
export function parseCriteria(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > Hosted.CRITERIA_MAX)
    throw request("Give the job one to ten success criteria.")
  return value.map((item) => {
    const criterion = oneLine(item, Hosted.CRITERION_MAX)
    if (!criterion) throw request("Write each success criterion on one line, in at most 300 characters.")
    return criterion
  })
}

/**
 * Public pages (a recurring job must name one): https on port 443, no credentials, a host that is not private, local or
 * reserved by name or address (S8's name rules), at most 2,048 characters, without a fragment.
 */
export function parsePages(value: unknown, required: boolean) {
  if (value === undefined || value === null) {
    if (required) throw request("A recurring job works from public pages: name one to five.")
    return undefined
  }
  if (!Array.isArray(value) || value.length > Hosted.PAGES_MAX || (required && value.length < 1))
    throw request("Name one to five public pages.")
  const pages = value.map((item) => {
    if (typeof item !== "string" || item.length > Hosted.PAGE_URL_MAX) throw request("Name each page by its https address.")
    let url: URL
    try {
      url = safeUrl(item)
    } catch (error) {
      if (error instanceof SafeFetchError) throw request("Each page must be a public https address.")
      throw error
    }
    url.hash = ""
    return url.href
  })
  return pages.length ? [...new Set(pages)] : undefined
}

function parseTitle(value: unknown) {
  if (value === undefined || value === null) return undefined
  const title = oneLine(value, Hosted.TITLE_MAX)
  if (!title) throw request("Give the job a title of at most 120 characters on one line.")
  return title
}

function parseSize(value: unknown, caps: { sizes: readonly Hosted.Size[] }): Hosted.Size {
  const size = value ?? "standard"
  if (!Hosted.isSize(size)) throw request("Choose the standard or large size.")
  if (!caps.sizes.includes(size))
    throw new ApiError(403, "HOSTED_NOT_INCLUDED", "This computer size is not included in your plan.", {
      detail: { perk: "computer", limit: "size" },
    })
  return size
}

function parseJobMinutes(value: unknown, caps: { jobMin: number }, room: number) {
  const minutes = value === undefined || value === null ? Math.min(caps.jobMin, Math.floor(room / MINUTE)) : value
  if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < Hosted.JOB_MINUTES_MIN)
    throw request("A job runs at least 15 minutes. Leave enough time before it should be delivered.")
  if (minutes > caps.jobMin)
    throw new ApiError(403, "HOSTED_NOT_INCLUDED", "This job is longer than your plan allows right now.", {
      detail: { perk: "computer", limit: "job-length" },
    })
  if (minutes * MINUTE > room) throw request("The job's minutes do not fit before the time it should be delivered.")
  return minutes
}

/** A UTC time of day in minutes (0 to 1439) and its UTC weekdays (0 = Sunday; every day when none are given). */
export function parseSchedule(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw request("Say when the recurring job runs.")
  const body = value as Record<string, unknown>
  const timeOfDay = body.timeOfDay
  if (typeof timeOfDay !== "number" || !Number.isSafeInteger(timeOfDay) || timeOfDay < 0 || timeOfDay >= 1440)
    throw request("Give the time of day in minutes after midnight UTC.")
  const days = body.days === undefined || body.days === null ? [0, 1, 2, 3, 4, 5, 6] : body.days
  if (
    !Array.isArray(days) ||
    days.length < 1 ||
    days.length > 7 ||
    days.some((day) => typeof day !== "number" || !Number.isSafeInteger(day) || day < 0 || day > 6)
  )
    throw request("Choose the days as UTC weekdays, 0 for Sunday to 6 for Saturday.")
  return { timeOfDay, days: [...new Set(days as number[])].sort((a, b) => a - b) }
}

/** The first run of a schedule strictly after `after`. */
export function nextRun(after: number, schedule: { timeOfDay: number; days: readonly number[] }) {
  const midnight = Math.floor(after / DAY) * DAY
  for (let day = 0; day <= 8; day++) {
    const at = midnight + day * DAY + schedule.timeOfDay * MINUTE
    if (at > after && schedule.days.includes(new Date(at).getUTCDay())) return at
  }
  throw new Error("A schedule names no day.")
}

// ── The session's prompt ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the job's session is told: the person's words, the success criteria, the time it aims to deliver by, its pages
 * (only public pages and no sign-in for a recurring job), that anything that would go live waits for the person, and
 * how to report.
 */
export function jobPrompt(record: Pick<JobRecord, "id" | "prompt" | "criteria" | "pages" | "deliverBy" | "recurring">) {
  const lines = [
    record.prompt,
    "",
    `This is a Done by Morning job (${record.id}). ${Hosted.DELIVER_LABEL} ${new Date(record.deliverBy).toISOString()}.`,
    "",
    "Success criteria:",
    ...record.criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  ]
  if (record.pages?.length)
    lines.push(
      "",
      record.recurring
        ? "Work only from these public pages. Do not sign in anywhere and do not enter personal details:"
        : "Pages to start from:",
      ...record.pages.map((page) => `- ${page}`),
    )
  lines.push(
    "",
    "Leave anything that would go live (merging, deploying, publishing, sending messages or payments) for the person to approve: open a pull request or leave a draft, and never merge it.",
    `When you are done, send the report with POST /api/hosted/jobs/${record.id}/report on the run-API host: first {summary, links, pullRequest?}, then {judge, results} with one pass or fail per criterion from the judge model that answer names.`,
  )
  return lines.join("\n")
}

// ── Queueing (the single entry) ────────────────────────────────────────────────────────────────────────────────────

export type EnqueueExtras = {
  title?: string
  jobMinutes?: number
  startAfter?: number
  pages?: readonly string[]
  /** One run of a recurring job: its definition and the run's own job id. */
  recurring?: { id: string; jobId: string }
}

/**
 * Queues a Done by Morning job (§4.17 `enqueueHostedJob(trigger)`, the single entry for every source). Checks, in order:
 * the trigger's source (reserved sources are refused with reason `source-unavailable`) and target; the services, the
 * `hosted` switch, the listing (or the owner's list) and holds; the plan from the snapshot (S1); the job itself (words,
 * one to ten criteria, pages, size, minutes, its time); then, atomically with queueing it, the plan's jobs a night
 * (counted on the UTC date of its deliver-by time) or, for a recurring job's run, recurring jobs a day. Answers the job.
 */
export async function enqueueHostedJob(
  trigger: RunTrigger,
  options: JobOptions & EnqueueExtras = {},
): Promise<Hosted.JobView> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (!RUN_SOURCES.includes(trigger.source) || !ENABLED_SOURCES.has(trigger.source))
    throw new ApiError(403, "HOSTED_JOB_REFUSED", "Jobs cannot be queued from here yet.", {
      detail: { reason: "source-unavailable" },
    })
  if (!trigger.target || trigger.target.kind !== "hosted-job") throw request("This is not a cloud computer job.")
  if (typeof trigger.account !== "string" || !ACCOUNT.test(trigger.account)) throw request()
  const account = trigger.account
  const now = clock()
  const { overnight, caps } = await requireJobPlan(account, options, now)

  const prompt = parsePrompt(trigger.prompt)
  const criteria = parseCriteria(trigger.criteria)
  const title = parseTitle(options.title)
  const recurring = options.recurring
  const pages = parsePages(options.pages, recurring !== undefined)
  const size = parseSize(trigger.target.size, caps)
  const startAfter = options.startAfter ?? now
  if (typeof startAfter !== "number" || !Number.isSafeInteger(startAfter) || startAfter < now - MINUTE)
    throw request("A job cannot start in the past.")
  const deliverBy = trigger.deliverBy
  if (typeof deliverBy !== "number" || !Number.isSafeInteger(deliverBy))
    throw request("Say when the job should be delivered by.")
  if (!recurring && (deliverBy < now + Hosted.DELIVER_MIN_MS || deliverBy > now + Hosted.DELIVER_MAX_MS))
    throw request("Queue a job to deliver between 30 minutes and a day from now.")
  if (recurring && deliverBy > now + Hosted.DELIVER_MAX_MS) throw request()
  const jobMinutes = parseJobMinutes(options.jobMinutes, caps, deliverBy - startAfter)

  const id = recurring?.jobId ?? newJobId()
  if (!Hosted.JOB_ID.test(id) || (recurring && !Hosted.RECURRING_ID.test(recurring.id))) throw request()
  const counterDate = utcDay(recurring ? startAfter : deliverBy)
  const counter = recurring
    ? hostedJobsRecurringDayKey(account, counterDate)
    : hostedJobsNightKey(account, counterDate)
  const cap = recurring ? overnight.recurringPerDay : overnight.perNight
  const record: JobRecord = {
    v: 1,
    id,
    account,
    source: trigger.source,
    purpose: trigger.purpose,
    state: "queued",
    ...(title ? { title } : {}),
    prompt,
    criteria,
    ...(pages ? { pages } : {}),
    size,
    jobMinutes,
    deliverBy,
    startAfter,
    createdAt: now,
    counter,
    ...(recurring ? { recurring: recurring.id } : {}),
    ...(trigger.requestedBy
      ? { requestedBy: { platform: String(trigger.requestedBy.platform).slice(0, 40), userId: String(trigger.requestedBy.userId).slice(0, 120) } }
      : {}),
  }
  if (jobPrompt(record).length > Hosted.PROMPT_MAX) throw request("The job, its criteria and pages are too long together.")
  const counted = Number(
    await store(
      [
        "EVAL",
        ENQUEUE,
        4,
        counter,
        hostedJobKey(id),
        hostedJobsDueKey(),
        hostedJobsAccountKey(account),
        cap,
        Math.max(DAY, Date.parse(`${counterDate}T00:00:00Z`) + 3 * DAY - now),
        JSON.stringify(record),
        jobKeepMs(record, now),
        id,
        startAfter,
        now,
      ],
      fetcher,
    ),
  )
  if (counted === -1) {
    const existing = await readJobRecord(id, fetcher)
    if (!existing || existing.account !== account) throw unavailable()
    return jobView(existing, undefined, now)
  }
  if (counted === 0)
    throw new ApiError(
      429,
      "HOSTED_JOB_LIMIT",
      recurring
        ? "Your plan's recurring jobs for that day are already queued."
        : "You have queued as many jobs for that night as your plan includes.",
      { detail: { limit: recurring ? "recurring-per-day" : "per-night", cap } },
    )
  if (!Number.isSafeInteger(counted) || counted < 0) throw unavailable()
  await pruneAccountIndex(account, now, fetcher).catch(() => undefined)
  return jobView(record, undefined, now)
}

/** Drops index entries for jobs queued long enough ago that their records and recordings are gone. */
async function pruneAccountIndex(account: string, now: number, fetcher: typeof fetch) {
  const old = await store(
    ["ZRANGEBYSCORE", hostedJobsAccountKey(account), "-inf", `(${now - ACCOUNT_INDEX_MS}`, "LIMIT", 0, 50],
    fetcher,
  )
  for (const id of Array.isArray(old) ? old : []) await store(["ZREM", hostedJobsAccountKey(account), String(id)], fetcher)
}

// ── Recurring jobs ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Saves a recurring job: it runs on public pages only (one to five, no sign-in, no repository), once on each chosen UTC
 * weekday at a UTC time of day. An account keeps at most the plan's recurring jobs a day, since each runs at most once a
 * day; each run is then queued through `enqueueHostedJob` and counted against the same cap for its date.
 */
export async function addRecurringJob(account: string, input: unknown, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  if (!ACCOUNT.test(account)) throw request()
  if (!input || typeof input !== "object" || Array.isArray(input)) throw request()
  const body = input as Record<string, unknown>
  const now = clock()
  const { overnight, caps } = await requireJobPlan(account, options, now)
  const schedule = parseSchedule(body.recurring)
  const title = parseTitle(body.title)
  const record: RecurringRecord = {
    v: 1,
    id: newRecurringId(),
    account,
    ...(title ? { title } : {}),
    prompt: parsePrompt(body.prompt),
    criteria: parseCriteria(body.criteria),
    pages: parsePages(body.pages, true)!,
    size: parseSize(body.size, caps),
    jobMinutes: parseJobMinutes(body.jobMinutes, caps, caps.jobMin * MINUTE),
    timeOfDay: schedule.timeOfDay,
    days: schedule.days,
    createdAt: now,
  }
  const nextAt = nextRun(now, record)
  if (jobPrompt({ ...record, id: recurringRunId(record.id, nextAt), deliverBy: nextAt, recurring: record.id }).length > Hosted.PROMPT_MAX)
    throw request("The job, its criteria and pages are too long together.")
  const saved = Number(
    await store(
      [
        "EVAL",
        RECUR,
        2,
        hostedRecurringKey(account),
        hostedRecurringDueKey(),
        record.id,
        JSON.stringify(record),
        overnight.recurringPerDay,
        `${account}:${record.id}`,
        nextAt,
      ],
      fetcher,
    ),
  )
  if (saved === 0)
    throw new ApiError(429, "HOSTED_JOB_LIMIT", "You have as many recurring jobs as your plan includes.", {
      detail: { limit: "recurring", cap: overnight.recurringPerDay },
    })
  if (saved !== 1) throw unavailable()
  return recurringView(record, nextAt)
}

async function readRecurring(account: string, fetcher: typeof fetch) {
  const flat = await store(["HGETALL", hostedRecurringKey(account)], fetcher)
  const found: RecurringRecord[] = []
  if (!Array.isArray(flat)) return found
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const record = Option.getOrUndefined(decodeRecurring(String(flat[index + 1])))
    if (record && record.account === account) found.push(record)
  }
  return found.sort((a, b) => a.createdAt - b.createdAt)
}

/** Removes one of the account's recurring jobs; runs already queued stay (cancel them one by one). */
export async function removeRecurringJob(account: string, id: unknown, fetcher: typeof fetch = fetch) {
  if (typeof id !== "string" || !Hosted.RECURRING_ID.test(id)) throw jobNotFound()
  const removed = Number(await store(["HDEL", hostedRecurringKey(account), id], fetcher))
  await store(["ZREM", hostedRecurringDueKey(), `${account}:${id}`], fetcher)
  if (removed !== 1) throw jobNotFound()
  return { id, removed: true as const }
}

/** Queues one run of a recurring job that is due, then schedules its next run. */
async function fireRecurring(member: string, at: number, options: JobOptions) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const split = member.lastIndexOf(":")
  const account = member.slice(0, split)
  const id = member.slice(split + 1)
  const raw = ACCOUNT.test(account) && Hosted.RECURRING_ID.test(id) ? await store(["HGET", hostedRecurringKey(account), id], fetcher) : null
  const record = typeof raw === "string" ? Option.getOrUndefined(decodeRecurring(raw)) : undefined
  if (!record || record.account !== account) {
    await store(["ZREM", hostedRecurringDueKey(), member], fetcher)
    return "removed" as const
  }
  const now = clock()
  let outcome: "queued" | "skipped" = "skipped"
  if (now - at <= RECURRING_LATE_MS) {
    try {
      await enqueueHostedJob(
        {
          source: "schedule",
          account,
          target: { kind: "hosted-job", size: record.size },
          prompt: record.prompt,
          criteria: record.criteria,
          deliverBy: now + record.jobMinutes * MINUTE + RECURRING_SLACK_MS,
          purpose: "scheduled",
        },
        {
          ...options,
          ...(record.title ? { title: record.title } : {}),
          jobMinutes: record.jobMinutes,
          startAfter: now,
          pages: record.pages,
          recurring: { id: record.id, jobId: recurringRunId(record.id, at) },
        },
      )
      outcome = "queued"
    } catch (error) {
      // A plan or cap refusal, or the service being off, skips this run; store trouble tries again next minute (until
      // the run is too late).
      if (!(error instanceof ApiError) || (error.statusCode >= 500 && error.code !== "HOSTED_UNAVAILABLE")) throw error
    }
  }
  await store(["ZADD", hostedRecurringDueKey(), nextRun(Math.max(at, now), record), member], fetcher)
  return outcome
}

// ── Running the queue (the reaper, every minute) ───────────────────────────────────────────────────────────────────

export type JobsPass = {
  settled: number
  fired: number
  started: number
  missed: number
  cancelled: number
  waiting: number
}

/**
 * The queue's pass (WP A53's `registerHostedJobsRunner`, from the reaper every minute): first every running job whose
 * session ended gets its outcome; then due recurring jobs queue their runs; then due jobs start, each after its plan,
 * the switch, the listing, a free place among the plan's jobs at once and (inside WP A53's start) the plan's hours and
 * computers. A job still queued at its deliver-by time is missed.
 */
export async function runDueHostedJobs(options: JobOptions & { budgetMs?: number } = {}): Promise<JobsPass> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const started = clock()
  const budget = options.budgetMs ?? 15_000
  const left = () => budget - (clock() - started)
  const pass: JobsPass = { settled: 0, fired: 0, started: 0, missed: 0, cancelled: 0, waiting: 0 }

  const live = await store(["ZRANGE", hostedJobsLiveKey(), 0, PASS_MAX * 4 - 1], fetcher)
  for (const id of Array.isArray(live) ? live : []) {
    if (left() <= 2_000) return pass
    if ((await settleRunningJob(String(id), options).catch(() => false)) === true) pass.settled++
  }

  const now = clock()
  const recurring = await store(
    ["ZRANGEBYSCORE", hostedRecurringDueKey(), "-inf", now, "WITHSCORES", "LIMIT", 0, PASS_MAX],
    fetcher,
  )
  const pairs = Array.isArray(recurring) ? recurring : []
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    if (left() <= 2_000) return pass
    const outcome = await fireRecurring(String(pairs[index]), Number(pairs[index + 1]), options).catch(() => undefined)
    if (outcome === "queued") pass.fired++
  }

  // The listing is the same for every account: read it once per pass.
  let listed: Promise<boolean> | undefined
  const open = (account: string) =>
    hostedAllowedAccounts().has(account.toLowerCase()) ||
    (listed ??= listedPerks(fetcher).then((perks) => perks.has("overnight")))
  const due = await store(["ZRANGEBYSCORE", hostedJobsDueKey(), "-inf", clock(), "LIMIT", 0, PASS_MAX], fetcher)
  for (const id of Array.isArray(due) ? due : []) {
    if (left() <= 3_000) return pass
    const outcome = await startDueJob(String(id), options, open).catch(() => "waiting" as const)
    if (outcome === "started") pass.started++
    else if (outcome === "missed") pass.missed++
    else if (outcome === "cancelled") pass.cancelled++
    else if (outcome === "waiting") pass.waiting++
  }
  return pass
}

type StartOutcome = "started" | "missed" | "cancelled" | "waiting" | "gone"

/** Why a start refusal leaves the job waiting (undefined) or misses it (its reason). */
function startRefusal(error: unknown): Hosted.JobReason | undefined {
  if (!(error instanceof ApiError)) return undefined
  switch (error.code) {
    case "HOSTED_HOURS_USED":
      return "hours"
    case "MODEL_PLAN_EXHAUSTED":
      return "usage"
    case "HOSTED_BUSY":
    case "HOSTED_PAUSED":
    case "HOSTED_UNAVAILABLE":
    case "MODEL_PLAN_RENEWING":
    case "MODEL_PLAN_DAILY_LIMIT":
    case "MODEL_PLAN_CONCURRENCY":
    case "MODEL_PLAN_BUSY":
    case "RATE_LIMITED":
      return undefined
  }
  return error.statusCode >= 500 ? undefined : "refused"
}

async function setWaiting(record: JobRecord, waiting: string, options: JobOptions) {
  if (record.waiting === waiting) return
  await updateJobRecord(
    record.id,
    (value) => (value.state === "queued" && value.waiting !== waiting ? { ...value, waiting } : undefined),
    options,
  ).catch(() => undefined)
}

/** Ends a queued job (missed or cancelled) and takes it off the queue. */
async function endQueued(record: JobRecord, state: "missed" | "cancelled", reason: Hosted.JobReason, options: JobOptions) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const now = clock()
  const ended = await updateJobRecord(
    record.id,
    (value) => (value.state === "queued" ? { ...value, state, reason, endedAt: now, waiting: undefined } : undefined),
    { fetcher, clock },
  )
  await store(["ZREM", hostedJobsDueKey(), record.id], fetcher)
  if (ended.state === state && state === "missed") await alertJob(ended, options)
  return ended
}

/** Starts one due job, if its plan and the queue allow it now. */
async function startDueJob(
  id: string,
  options: JobOptions,
  open: (account: string) => boolean | Promise<boolean>,
): Promise<StartOutcome> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const record = await readJobRecord(id, fetcher)
  if (!record || record.state !== "queued") {
    await store(["ZREM", hostedJobsDueKey(), id], fetcher)
    return "gone"
  }
  const now = clock()
  if (now >= record.deliverBy) {
    await endQueued(record, "missed", record.waiting === "paused" ? "paused" : "late", options)
    return "missed"
  }
  const [snapshot, service] = await Promise.all([
    readSnapshot(record.account, fetcher),
    readSwitch("hosted", fetcher, { now }),
  ])
  const plan = hostedAccess(snapshot, "on", now)
  if (!snapshot?.caps.overnight || plan === "stop") {
    const reason: Hosted.JobReason =
      snapshot?.state === "frozen" ? "frozen" : snapshot?.state === "ended" && snapshot.reason === "closing" ? "closing" : "plan"
    await endQueued(record, "cancelled", reason, options)
    return "cancelled"
  }
  if (plan === "wrap") {
    await setWaiting(record, "paused", options)
    return "waiting"
  }
  if (plan === "continue" || service !== "on" || !doneByMorningConfigured(options) || !(await open(record.account))) {
    await setWaiting(record, "queue", options)
    return "waiting"
  }
  const claimed = await store(["SET", hostedJobClaimKey(id), String(now), "NX", "PX", CLAIM_MS], fetcher)
  if (claimed !== "OK") return "waiting"
  const release = () => store(["DEL", hostedJobClaimKey(id)], fetcher).catch(() => undefined)
  try {
    await pruneRunning(record.account, fetcher)
    const slot = Number(
      await store(["EVAL", SLOT, 1, hostedJobsRunningKey(record.account), id, snapshot.caps.overnight.atOnce, 2 * DAY], fetcher),
    )
    if (slot !== 1) {
      await setWaiting(record, "busy", options)
      return "waiting"
    }
    // Marked running before the computer starts, so an overlapping pass can never start it twice.
    const running = await updateJobRecord(
      id,
      (value) => (value.state === "queued" ? { ...value, state: "running", startingAt: now, waiting: undefined } : undefined),
      { fetcher, clock },
    )
    if (running.state !== "running" || running.startingAt !== now) {
      await store(["SREM", hostedJobsRunningKey(record.account), id], fetcher)
      return "gone"
    }
    await store(["ZREM", hostedJobsDueKey(), id], fetcher)
    await store(["ZADD", hostedJobsLiveKey(), now, id], fetcher)
    let session: Hosted.SessionView
    try {
      session = await startHostedSession(
        record.account,
        {
          size: record.size,
          jobMinutes: record.jobMinutes,
          prompt: jobPrompt(record),
          title: record.title ?? "Done by Morning",
          source: "schedule",
        },
        options,
      )
    } catch (error) {
      const reason = startRefusal(error)
      await store(["SREM", hostedJobsRunningKey(record.account), id], fetcher).catch(() => undefined)
      await store(["ZREM", hostedJobsLiveKey(), id], fetcher).catch(() => undefined)
      const back = await updateJobRecord(
        id,
        (value) =>
          value.state === "running" && value.session === undefined
            ? reason
              ? { ...value, state: "missed", reason, endedAt: clock(), startingAt: undefined }
              : { ...value, state: "queued", startingAt: undefined, waiting: "busy" }
            : undefined,
        { fetcher, clock },
      )
      if (back.state === "queued") {
        await store(["ZADD", hostedJobsDueKey(), back.startAfter, id], fetcher)
        return "waiting"
      }
      if (back.state !== "missed" || back.reason !== reason) return "gone"
      await alertJob(back, options)
      return "missed"
    }
    await store(
      ["SET", hostedJobSessionKey(session.id), id, "PX", record.jobMinutes * MINUTE + DAY],
      fetcher,
    )
    await updateJobRecord(
      id,
      (value) => (value.state === "running" ? { ...value, session: session.id, startedAt: session.createdAt } : undefined),
      { fetcher, clock },
    )
    return "started"
  } finally {
    await release()
  }
}

/** Drops jobs that no longer run from the account's running set (a lost release, a fault mid-start). */
async function pruneRunning(account: string, fetcher: typeof fetch) {
  const members = await store(["SMEMBERS", hostedJobsRunningKey(account)], fetcher)
  for (const id of Array.isArray(members) ? members : []) {
    const record = await readJobRecord(String(id), fetcher)
    if (!record || record.state !== "running") await store(["SREM", hostedJobsRunningKey(account), String(id)], fetcher)
  }
}

/**
 * A running job's outcome once its session ended: `reported` when the agent sent its report (with the second lab's pass
 * or fail when it came), else `incomplete` with the session's end reason. Answers true when it ended the job.
 */
async function settleRunningJob(id: string, options: JobOptions) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const record = await readJobRecord(id, fetcher)
  const forget = async (job?: JobRecord) => {
    await store(["ZREM", hostedJobsLiveKey(), id], fetcher)
    if (job) {
      await store(["SREM", hostedJobsRunningKey(job.account), id], fetcher)
      if (job.session) await store(["DEL", hostedJobSessionKey(job.session)], fetcher)
    }
  }
  if (!record || record.state !== "running") {
    await forget(record)
    return false
  }
  const now = clock()
  let session: SessionRecord | undefined
  if (record.session) {
    session = await readSessionRecord(record.session, fetcher)
    if (session && session.state !== "ended") return false
  } else if (now - (record.startingAt ?? record.createdAt) < START_LINK_MS) return false
  const ended = await updateJobRecord(
    id,
    (value) => {
      if (value.state !== "running") return undefined
      const endedAt = session?.endedAt ?? now
      if (value.report) return { ...value, state: "reported", reason: undefined, endedAt }
      return { ...value, state: "incomplete", reason: session?.reason ?? (value.session ? "lapsed" : "failed"), endedAt }
    },
    { fetcher, clock },
  )
  await forget(ended)
  await alertJob(ended, options)
  return true
}

/** The title-only phone alert for a job that ended (P7: no job text, tag `overnight`). Never fails the caller. */
async function alertJob(record: JobRecord, options: JobOptions) {
  const title =
    record.state === "reported"
      ? "Done by Morning: a job is ready"
      : record.state === "incomplete"
        ? "Done by Morning: a job did not finish"
        : record.state === "missed"
          ? "Done by Morning: a job could not start in time"
          : undefined
  if (!title) return
  const send =
    options.alert ??
    ((account: string, alert: { title: string; tag: string }) =>
      sendServerAlert(account, alert, { fetcher: options.fetcher, now: (options.clock ?? Date.now)() }))
  await send(record.account, { title, tag: "overnight" }).catch(() => undefined)
}

// ── The person's actions ───────────────────────────────────────────────────────────────────────────────────────────

/** `account`'s job `id`, or 404 (another account's job is not found either). */
export async function requireOwnJob(account: string, id: unknown, fetcher: typeof fetch = fetch) {
  if (typeof id !== "string" || !Hosted.JOB_ID.test(id)) throw jobNotFound()
  const record = await readJobRecord(id, fetcher)
  if (!record || record.account !== account) throw jobNotFound()
  return record
}

/**
 * The person's queue (`GET /api/hosted/jobs`): its state, the plan's public Done by Morning caps, the newest 50 jobs
 * (running and queued first) and the recurring jobs. Counts, times and the person's own words only (P1).
 */
export async function listHostedJobs(account: string, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const now = clock()
  const [snapshot, service, open] = await Promise.all([
    readSnapshot(account, fetcher),
    readSwitch("hosted", fetcher, { now }),
    hostedJobsOpen(account, fetcher),
  ])
  const ids = await store(["ZREVRANGE", hostedJobsAccountKey(account), 0, 49], fetcher)
  const jobs: Hosted.JobView[] = []
  for (const id of Array.isArray(ids) ? ids : []) {
    const record = await readJobRecord(String(id), fetcher)
    if (record && record.account === account) jobs.push(jobView(record, await readSlots(record.id, fetcher), now))
  }
  const order: Record<Hosted.JobState, number> = { running: 0, queued: 1, reported: 2, incomplete: 2, cancelled: 2, missed: 2 }
  jobs.sort((a, b) => order[a.state] - order[b.state] || b.createdAt - a.createdAt)
  const recurring: Hosted.RecurringView[] = []
  for (const record of await readRecurring(account, fetcher)) {
    const next = Number(await store(["ZSCORE", hostedRecurringDueKey(), `${account}:${record.id}`], fetcher))
    recurring.push(recurringView(record, Number.isSafeInteger(next) && next > 0 ? next : nextRun(now, record)))
  }
  const overnight = snapshot?.plan ? snapshot.caps.overnight : null
  return {
    available: doneByMorningConfigured(options) && open && service === "on",
    queue: queueState(snapshot, service, open && doneByMorningConfigured(options), now),
    ...(overnight
      ? { plan: { perNight: overnight.perNight, atOnce: overnight.atOnce, recurringPerDay: overnight.recurringPerDay } }
      : {}),
    jobs,
    recurring,
  }
}

/**
 * One job for its owner (`GET /api/hosted/jobs/<id>`), with 15-minute links to its recording's segments while it is
 * kept (30 days after the job ended). Only the job's owner reaches this (the route checks the sign-in).
 */
export async function readHostedJob(account: string, id: unknown, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const record = await requireOwnJob(account, id, fetcher)
  const now = clock()
  const slots = await readSlots(record.id, fetcher)
  const job = jobView(record, slots, now)
  if (!job.recording || !r2Configured("media")) return { job }
  const segments = [...slots.entries()]
    .filter(([, slot]) => slot.state === "u")
    .sort((a, b) => a[1].n - b[1].n)
    .map(([index, slot]) => {
      const link = presignR2("media", {
        method: "GET",
        key: recordingKey(record.account, record.id, index),
        expiresIn: 900,
        now,
        response: {
          contentType: "video/mp2t",
          cacheControl: "private, no-store",
          contentDisposition: `attachment; filename="vector-recording-${record.id}-${slot.n}.ts"`,
        },
      })
      return { n: slot.n, url: link.url, expiresAt: link.expiresAt }
    })
  return { job, recording: { segments } }
}

/**
 * The person cancels a job. A queued job leaves the queue and gives its night's count back; a running job's session is
 * stopped (its disk is saved, its time charged as it ran). A job that already ended is answered as it is.
 */
export async function cancelHostedJob(account: string, id: unknown, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const record = await requireOwnJob(account, id, fetcher)
  if (Hosted.JOB_FINAL_STATES.includes(record.state)) return jobView(record, undefined, clock())
  if (record.state === "queued") {
    const ended = await endQueued(record, "cancelled", "cancelled", options)
    if (ended.state === "cancelled" && ended.reason === "cancelled")
      await store(["EVAL", REFUND, 1, record.counter], fetcher).catch(() => undefined)
    return jobView(ended, undefined, clock())
  }
  if (record.session)
    await stopHostedSession(account, record.session, options).catch((error) => {
      // A session already gone leaves nothing to stop.
      if (!(error instanceof ApiError && error.statusCode === 404)) throw error
    })
  const now = clock()
  const ended = await updateJobRecord(
    record.id,
    (value) => (value.state === "running" ? { ...value, state: "cancelled", reason: "cancelled", endedAt: now } : undefined),
    { fetcher, clock },
  )
  await store(["ZREM", hostedJobsLiveKey(), record.id], fetcher)
  await store(["SREM", hostedJobsRunningKey(account), record.id], fetcher)
  return jobView(ended, await readSlots(record.id, fetcher), now)
}

/**
 * The person approves a job's pull request (`POST /api/hosted/jobs/<id>/approve`): the server records when and answers
 * the pull request's address for the person's own client to open, where the person merges it. The server opens,
 * merges and writes nothing (S9).
 */
export async function approveHostedJob(account: string, id: unknown, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const record = await requireOwnJob(account, id, fetcher)
  const url = record.report?.pullRequest
  if (!url || (record.state !== "running" && record.state !== "reported"))
    throw new ApiError(409, "HOSTED_JOB_STATE", "This job has no pull request to approve.")
  const now = clock()
  const approved = await updateJobRecord(
    record.id,
    (value) => (value.approvedAt === undefined ? { ...value, approvedAt: now } : undefined),
    { fetcher, clock },
  )
  return { url, job: jobView(approved, undefined, now) }
}

// ── The report (the job's session, with its own run token) ─────────────────────────────────────────────────────────

/** A pull request (or a branch's compare page) on the code host the computer pushes to. */
const PULL_REQUEST =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}\/(?:pull\/[1-9]\d{0,9}|compare\/[A-Za-z0-9._\/-]{1,200}(?:\.\.\.?[A-Za-z0-9._\/-]{1,200})?(?:\?expand=1)?)$/

function parseLinks(value: unknown) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > Hosted.LINKS_MAX) throw request("Send at most 20 links.")
  return value.map((item) => {
    const entry: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : { url: item }
    if (typeof entry.url !== "string" || entry.url.length > Hosted.PAGE_URL_MAX) throw request("Send each link as an https address.")
    let url: URL
    try {
      url = new URL(entry.url)
    } catch {
      throw request("Send each link as an https address.")
    }
    if (url.protocol !== "https:" || url.username || url.password) throw request("Send each link as an https address.")
    const title = entry.title === undefined || entry.title === null ? undefined : oneLine(entry.title, Hosted.LINK_TITLE_MAX)
    if (entry.title !== undefined && entry.title !== null && !title) throw request("Keep each link's title to one short line.")
    return { ...(title ? { title } : {}), url: url.href }
  })
}

type ModelUse = { model: string; count: number; at: number; lab?: string }

/** The models a hosted session's settled requests used, from the gateway's log. */
export async function readSessionModels(session: string, fetcher: typeof fetch = fetch) {
  const flat = await store(["HGETALL", hostedSessionModelsKey(session)], fetcher)
  const uses = new Map<string, ModelUse>()
  const use = (model: string) => {
    let found = uses.get(model)
    if (!found) uses.set(model, (found = { model, count: 0, at: 0 }))
    return found
  }
  if (!Array.isArray(flat)) return []
  for (let index = 0; index + 1 < flat.length; index += 2) {
    const field = String(flat[index])
    const value = String(flat[index + 1])
    const model = field.slice(2)
    if (!model) continue
    if (field.startsWith("c:")) use(model).count = Number(value) || 0
    else if (field.startsWith("t:")) use(model).at = Number(value) || 0
    else if (field.startsWith("l:") && value) use(model).lab = value
  }
  return [...uses.values()]
}

/**
 * Notes one settled model request of a hosted session (the gateway's `afterSettle`, through hosted-run.ts): which model,
 * its lab and when. The report's judge must come from a lab none of these used.
 */
export async function recordHostedSessionModel(
  session: string,
  model: { id: string; lab?: string },
  at: number,
  fetcher: typeof fetch = fetch,
) {
  if (!Hosted.SESSION_ID.test(session) || !model.id || model.id.length > 200) return
  await store(["EVAL", MODELS, 1, hostedSessionModelsKey(session), model.id, at, model.lab ?? "", MODELS_KEEP_MS], fetcher)
}

/**
 * The judge for a report: a model from the plan's Second opinion judges (§4.12 `CODIUM_JUDGES`, as the gateway serves
 * them now) whose lab none of the session's own requests used. The judge of the session's most used model comes
 * first. Undefined when no such model is served, or when a model the session used has no known lab (then no lab can
 * be said to differ).
 */
export function chooseJudge(
  served: { judges: Readonly<Record<string, string>>; labs: Readonly<Record<string, string | undefined>> },
  uses: readonly ModelUse[],
): { model: string; lab: string } | undefined {
  const worked = uses.filter((use) => use.count > 0)
  if (worked.some((use) => !(use.lab ?? served.labs[use.model]))) return undefined
  const labs = new Set(worked.map((use) => (use.lab ?? served.labs[use.model])!))
  const primary = [...worked].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model))[0]?.model
  const candidates = [
    ...(primary && served.judges[primary] ? [served.judges[primary]!] : []),
    ...[...new Set(Object.values(served.judges))].sort(),
  ]
  for (const model of candidates) {
    const lab = served.labs[model]
    if (lab && !labs.has(lab)) return { model, lab }
  }
  return undefined
}

/**
 * The job's report (`POST /api/hosted/jobs/<id>/report` on the run-API host), accepted only with that job's own run
 * token (its session's `vht_`; S3, S7 checked by the route) while its session runs. Two steps:
 * 1. `{summary, links?, pullRequest?}`: the work. The server picks the judge (another lab than every model the session
 *    used) and answers `{judge: {model}}`, or `{judge: null}` when none can be picked: the report then stands unjudged.
 * 2. `{judge, results: [{pass, note?}]}`, one per criterion, in order: accepted only for the judge the server named,
 *    and only once the session asked that model after step 1 (the gateway's log).
 */
export async function recordJobReport(claims: HostedRunClaims, id: string, input: unknown, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const record = await readJobRecord(id, fetcher)
  if (!record || record.account !== claims.account) throw jobNotFound()
  if (record.session !== claims.session)
    throw new ApiError(403, "HOSTED_RUN_REFUSED", "This run token is for another job.")
  if (record.state !== "running") throw jobState("This job is not running.")
  const session = await readSessionRecord(claims.session, fetcher)
  if (!session || session.state === "ended" || session.state === "stopping") throw jobState("This job's session has ended.")
  if (!input || typeof input !== "object" || Array.isArray(input)) throw request()
  const body = input as Record<string, unknown>
  const now = clock()

  if (body.results === undefined) {
    if (Object.keys(body).some((key) => !["summary", "links", "pullRequest"].includes(key)))
      throw request("Send summary, links and pullRequest.")
    if (record.report) {
      // A retry of step 1 (its answer was lost) gets the same answer.
      if (record.report.results) throw jobState("This job's report is already in.")
      return { judge: record.report.judge ? { model: record.report.judge.model } : null, criteria: [...record.criteria] }
    }
    if (typeof body.summary !== "string" || !body.summary.trim() || body.summary.length > Hosted.SUMMARY_MAX || body.summary.includes("\u0000"))
      throw request("Summarise the work in at most 4,000 characters.")
    const links = parseLinks(body.links)
    let pullRequest: string | undefined
    if (body.pullRequest !== undefined && body.pullRequest !== null) {
      if (typeof body.pullRequest !== "string" || !PULL_REQUEST.test(body.pullRequest))
        throw request("Send the pull request's address.")
      pullRequest = body.pullRequest
    }
    const snapshot = await readSnapshot(record.account, fetcher)
    const uses = await readSessionModels(claims.session, fetcher)
    const served = snapshot?.plan
      ? await servedJudges(snapshot.plan, fetcher, options.catalog).catch(() => undefined)
      : undefined
    const judge = served ? chooseJudge(served, uses) : undefined
    const workerLabs = [
      ...new Set(uses.filter((use) => use.count > 0).map((use) => use.lab ?? served?.labs[use.model] ?? "unknown")),
    ].sort()
    await updateJobRecord(
      record.id,
      (value) =>
        value.state === "running" && !value.report
          ? {
              ...value,
              report: {
                summary: body.summary as string,
                links,
                ...(pullRequest ? { pullRequest } : {}),
                submittedAt: now,
                workerLabs,
                ...(judge ? { judge } : {}),
              },
            }
          : undefined,
      { fetcher, clock },
    )
    return { judge: judge ? { model: judge.model } : null, criteria: [...record.criteria] }
  }

  if (Object.keys(body).some((key) => !["judge", "results"].includes(key))) throw request("Send judge and results.")
  const report = record.report
  if (!report) throw jobState("Send the summary first.")
  if (report.results) throw jobState("This job's report is already in.")
  if (!report.judge) throw jobState("No judge was named for this report.")
  if (body.judge !== report.judge.model)
    throw new ApiError(409, "HOSTED_JOB_JUDGE", "Use the judge model this job's report named.")
  const asked = (await readSessionModels(claims.session, fetcher)).find((use) => use.model === report.judge!.model)
  if (!asked || asked.count < 1 || asked.at < report.submittedAt)
    throw new ApiError(409, "HOSTED_JOB_JUDGE", "Ask the judge model this job's report named first.")
  if (!Array.isArray(body.results) || body.results.length !== record.criteria.length)
    throw request("Send one result per success criterion, in order.")
  const results = body.results.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof (item as { pass?: unknown }).pass !== "boolean")
      throw request("Send each result as {pass, note?}.")
    const entry = item as { pass: boolean; note?: unknown }
    const note = entry.note === undefined || entry.note === null ? undefined : oneLine(entry.note, Hosted.NOTE_MAX)
    if (entry.note !== undefined && entry.note !== null && !note) throw request("Keep each note to one line of at most 500 characters.")
    return { pass: entry.pass, ...(note ? { note } : {}) }
  })
  await updateJobRecord(
    record.id,
    (value) =>
      value.state === "running" && value.report && !value.report.results
        ? { ...value, report: { ...value.report, results, judgedAt: now } }
        : undefined,
    { fetcher, clock },
  )
  return { accepted: true as const }
}

// ── Recordings (the job's session's heartbeat) ─────────────────────────────────────────────────────────────────────

function segmentList(value: unknown) {
  if (!Array.isArray(value)) return []
  const found: { n: number; bytes: number }[] = []
  for (const item of value.slice(0, Hosted.RECORDING_REPORT_MAX)) {
    if (!item || typeof item !== "object") continue
    const { n, bytes } = item as { n?: unknown; bytes?: unknown }
    if (
      typeof n === "number" &&
      Number.isSafeInteger(n) &&
      n >= 0 &&
      n <= 1_000_000 &&
      typeof bytes === "number" &&
      Number.isSafeInteger(bytes) &&
      bytes > 0 &&
      bytes <= Hosted.RECORDING_SEGMENT_MAX_BYTES
    )
      found.push({ n, bytes })
  }
  return found
}

function numberList(value: unknown, max: number) {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, max)
    .filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000)
}

/**
 * Done by Morning's part of a session's heartbeat (WP A53's `registerHostedHeartbeatHook`). For a session that runs a
 * job, the answer carries `recording`: one signed PUT for each finished segment the computer reported that falls in the
 * last `Hosted.RECORDING_SEGMENTS` (each into slot n mod 10), and segments it says it uploaded are checked by size
 * before they count. Any other session's answer is left as it is.
 */
export async function jobHeartbeat(context: {
  record: SessionRecord
  input: unknown
  answer: Hosted.HeartbeatAnswer
  now: number
  fetcher: typeof fetch
}) {
  const { record, input, answer, now, fetcher } = context
  if (!r2Configured("media")) return
  const id = await store(["GET", hostedJobSessionKey(record.id)], fetcher)
  if (typeof id !== "string") return
  const job = await readJobRecord(id, fetcher)
  if (!job || job.session !== record.id || job.account !== record.account || job.state !== "running") return
  answer.recording = { uploads: [] }
  const body = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const reported = segmentList(body.segments)
  const uploaded = numberList(body.uploadedSegments, Hosted.RECORDING_SEGMENTS)
  if (!reported.length && !uploaded.length) return
  const slots = await readSlots(job.id, fetcher)
  const key = hostedJobRecordingKey(job.id)
  let checks = 0
  for (const n of uploaded) {
    const slot = n % Hosted.RECORDING_SEGMENTS
    const entry = slots.get(slot)
    if (!entry || entry.n !== n || entry.state !== "p" || checks >= Hosted.RECORDING_REPORT_MAX) continue
    checks++
    const head = presignR2("media", { method: "HEAD", key: recordingKey(job.account, job.id, slot), expiresIn: 60, now })
    const found = await fetcher(head.url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(
      () => undefined,
    )
    if (found?.ok && Number(found.headers.get("content-length")) === entry.bytes) {
      const value: Slot = { ...entry, state: "u", at: now }
      slots.set(slot, value)
      await store(["HSET", key, slot, `${value.n}:${value.bytes}:u:${now}`], fetcher)
    }
  }
  const newest = Math.max(-1, ...[...slots.values()].map((entry) => entry.n), ...reported.map((segment) => segment.n))
  for (const segment of reported) {
    if (segment.n < newest - (Hosted.RECORDING_SEGMENTS - 1)) continue
    const slot = segment.n % Hosted.RECORDING_SEGMENTS
    const entry = slots.get(slot)
    if (entry && (entry.n > segment.n || (entry.n === segment.n && entry.state === "u"))) continue
    const put = presignR2("media", {
      method: "PUT",
      key: recordingKey(job.account, job.id, slot),
      contentLength: segment.bytes,
      contentType: "video/mp2t",
      expiresIn: 900,
      now,
    })
    answer.recording.uploads.push({ n: segment.n, url: put.url, headers: put.headers, expiresAt: put.expiresAt })
    const value: Slot = { n: segment.n, bytes: segment.bytes, state: "p", at: now }
    slots.set(slot, value)
    await store(["HSET", key, slot, `${value.n}:${value.bytes}:p:${now}`], fetcher)
  }
  await store(["PEXPIRE", key, jobKeepMs(job, now)], fetcher)
}

// ── The plan's changes and account deletion ────────────────────────────────────────────────────────────────────────

async function accountJobs(account: string, fetcher: typeof fetch) {
  const ids = await store(["ZRANGE", hostedJobsAccountKey(account), 0, -1], fetcher)
  return (Array.isArray(ids) ? ids : []).map(String).filter((id) => Hosted.JOB_ID.test(id))
}

/**
 * Done by Morning's part of the `hosted` provisioner (§4.4's row), idempotent:
 * - account deletion (`closing`): everything erased (P5);
 * - frozen (a dispute, an early-fraud warning, the owner): every queued job cancelled; recurring jobs are kept but do
 *   not run while frozen, so a won dispute brings them back;
 * - ended, no plan, or a plan without Done by Morning: every queued job cancelled and every recurring job removed;
 * - active, renewing and paused: nothing here (the runner starts nothing while renewing or paused; a paused plan's
 *   queue waits, and its jobs are missed if the payment does not come through before their time).
 * Running jobs' sessions are wrapped up or stopped by WP A53's part of the same provisioner; the runner then records
 * their outcome.
 */
export async function applyHostedJobsTransition(t: Transition, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const { to } = t
  if (to.state === "ended" && to.reason === "closing") return eraseAccountHostedJobs(t.account, options)
  const frozen = to.state === "frozen"
  const closed = to.state === "ended" || to.state === "none" || !to.plan || !to.caps.overnight
  if (!frozen && !closed) return
  for (const id of await accountJobs(t.account, fetcher)) {
    const record = await readJobRecord(id, fetcher)
    if (record?.state === "queued") await endQueued(record, "cancelled", frozen ? "frozen" : "plan", options)
  }
  if (frozen) return
  for (const record of await readRecurring(t.account, fetcher))
    await store(["ZREM", hostedRecurringDueKey(), `${t.account}:${record.id}`], fetcher)
  await store(["DEL", hostedRecurringKey(t.account)], fetcher)
}

/**
 * Account deletion's part of Done by Morning (P5; the `hosted` provisioner on `closing`, and WP A57): every recording
 * deleted from the media bucket, then every job record, its links and counters, the recurring jobs and the session
 * models logs. A step that fails throws, so the outbox retries.
 */
export async function eraseAccountHostedJobs(account: string, options: JobOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const ids = await accountJobs(account, fetcher)
  const counters = new Set<string>()
  let recordings = 0
  for (const id of ids) {
    const record = await readJobRecord(id, fetcher)
    const slots = await readSlots(id, fetcher)
    if (slots.size) {
      if (!r2Configured("media")) throw unavailable()
      for (const slot of slots.keys()) {
        const target = presignR2("media", { method: "DELETE", key: recordingKey(account, id, slot), expiresIn: 60, now: clock() })
        const answer = await fetcher(target.url, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(10_000) })
        if (!answer.ok && answer.status !== 404) throw unavailable()
        recordings++
      }
    }
    if (record?.counter) counters.add(record.counter)
    const keys = [hostedJobKey(id), hostedJobRecordingKey(id), hostedJobClaimKey(id)]
    if (record?.session) keys.push(hostedJobSessionKey(record.session), hostedSessionModelsKey(record.session))
    await store(["DEL", ...keys], fetcher)
    await store(["ZREM", hostedJobsDueKey(), id], fetcher)
    await store(["ZREM", hostedJobsLiveKey(), id], fetcher)
  }
  for (const record of await readRecurring(account, fetcher))
    await store(["ZREM", hostedRecurringDueKey(), `${account}:${record.id}`], fetcher)
  // Every hosted session of the account may have a models log, job or not.
  const sessions = await store(["ZRANGE", hostedSessionsKey(account), 0, -1], fetcher)
  const logs = (Array.isArray(sessions) ? sessions : []).map((session) => hostedSessionModelsKey(String(session)))
  for (let index = 0; index < logs.length; index += 200) await store(["DEL", ...logs.slice(index, index + 200)], fetcher)
  await store(
    ["DEL", hostedJobsAccountKey(account), hostedJobsRunningKey(account), hostedRecurringKey(account), ...counters],
    fetcher,
  )
  return { jobs: ids.length, recordings }
}

// ── Errors ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function jobNotFound() {
  return new ApiError(404, "HOSTED_JOB_NOT_FOUND", "This Done by Morning job was not found.")
}

function jobState(message: string) {
  return new ApiError(409, "HOSTED_JOB_STATE", message)
}

