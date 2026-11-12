import {
  ACCOUNT_ID_PATTERN,
  BRANCH_PATTERN,
  COMPUTER_CAPS,
  CONTEXT_SOURCES,
  DECLINE_CODES,
  DEVICE_ID_PATTERN,
  HEAD_SHA_PATTERN,
  JOB_ID_PATTERN,
  JOB_STATES,
  LIMITS,
  MILESTONES,
  OUTCOMES,
  PERMISSION_ID_PATTERN,
  PLATFORMS,
  PR_URL_PATTERN,
  RANDOM_ID_PATTERN,
  REFUSAL_CODES,
  REPLY_FORMAT,
  SERVER_CAPS,
  TERMINAL_STATES,
  TIMING,
  createJobId,
  decodeJob,
  installationPlatform,
  isIssueKey,
  isRepositoryName,
  randomId,
  sanitizeLabel,
  type DeclineCode,
  type EverywhereJob,
  type JobState,
  type Milestone,
  type Outcome,
  type PlatformId,
  type RefusalCode,
  type Report,
  type Settle,
  type UntrustedItem,
} from "../../../packages/schema/src/everywhere.js"
import { ENDINGS, queueDeadline, type Ending } from "../../../packages/schema/src/everywhere-policy.js"
import { ApiError } from "../http.js"
import { appendAudit, type AuditInput } from "./audit.js"
import type { OfferKey } from "./config.js"
import { openJson, sealJson, type DataKey } from "./crypto.js"
import type { JobEraser } from "./erase.js"
import { KEEP_MS, everywhereKeys, userIdValid } from "./keys.js"
import { signOffer, type SignedOffer } from "./offer.js"
import {
  deleteKeys,
  getValue,
  runScript,
  setJson,
  setValue,
  storeInteger,
  storeUnavailable,
  type Store,
} from "./store.js"

/*
 * Jobs, leases and their state machine (contract 3.4, E4, E8, E18).
 *
 *   received ─► refused | offered | dispatched | waiting
 *   offered  ─► claimed | dispatched | waiting | refused | expired
 *   claimed  ─► running | lost | refused (a decline under the lease, whatever its reason)
 *   running  ─► settled | lost (laptop only) | refused (a decline under the lease) | failed (Actions only)
 *   dispatched ─► running | failed (no start hook in 900 s)
 *   waiting  ─► offered | claimed | expired
 *   any live state ─► cancelled
 *
 * A claim is final: a job a computer held never goes back to an offer, the queue or Actions (3.4, E8), so no other
 * computer and no Actions run can start it while that computer may still be working on it.
 *
 * Every change is one Redis EVAL fenced by the record's version: the script writes only while the record still holds
 * the version and state it was read with, so two changes made from the same read (a claim racing a dispatch) leave
 * exactly one winner, and the loser reads again and sees what happened. The record is JSON whose first two fields are
 * always `version` and `state`, so the script reads them with a fixed pattern and needs no JSON library.
 *
 * Each live job is in four indexes: `jobs:due` (by its next timeout, for the sweep), `jobs:<sponsor>` (live and
 * waiting jobs, which the live cap counts), `livejobs:<installation>` (for erasing an installation) and
 * `history:<sponsor>` (every job of the last 30 days, for the job list and for erasing an account). A job leaves the
 * first three when it ends, in the same script that ends it, and its encrypted body is deleted then too.
 *
 * The body (task and context) is sealed under the data key and lives at most 2 hours; no job waits longer than its
 * body lives, and a claim that finds the body gone ends the job `expired`. Nothing here stores code, diffs, file names
 * or pull request text: reports are milestone ids and counts, and a settle carries a short summary (sealed) and links.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------------------

export const JOB_KINDS = ["mention", "assign", "dm", "followup"] as const
export type JobKind = (typeof JOB_KINDS)[number]
export type JobRoute = "laptop" | "actions" | "queue"

/** A job still in `received` this long after intake was never routed (the intake died): it ends `expired`. */
export const RECEIVED_STALE_MS = 2 * 60_000
/**
 * An Actions run still `running` this long after it started has passed @vector's longest run (120 minutes on the
 * largest plan) and its publish step; it ends `failed` unless VE-30's settle hook or `listCloudRuns` settled it.
 */
export const ACTIONS_OVERDUE_MS = 135 * 60_000
/** How many times a change is tried again after another change won the race. */
const ATTEMPTS = 8

export type JobDecline = { readonly device: string; readonly reason: DeclineCode }
export type JobLease = { readonly id: string; readonly expiresAt: number }
export type JobLimits = { readonly maxUsd: number; readonly minutes: number; readonly deadline: number }
export type JobResult = {
  readonly branch?: string
  readonly prUrl?: string
  readonly headSha?: string
  readonly files?: number
  readonly checks?: "skipped"
  readonly needs?: readonly string[]
}

export type JobRecord = {
  /** The fence: one more on every change. Always the first field. */
  readonly version: number
  /** Always the second field. */
  readonly state: JobState
  readonly jid: string
  readonly platform: PlatformId
  readonly installation: string
  readonly kind: JobKind
  /** The platform user who asked and the Vector account they are linked to. Their display name lives in the body. */
  readonly requester: { readonly userId: string; readonly account: string }
  /** Who pays: the requester's own account at launch; the binder for a GitHub handoff. */
  readonly sponsor: string
  /** `shared`: a public repository. */
  readonly repository: { readonly id: number; readonly fullName: string; readonly shared: boolean }
  readonly issue?: { readonly key: string }
  readonly github?: { readonly kind: "issue" | "pr"; readonly number: number; readonly commentId?: number }
  /** The reply goes to a shared place (1). */
  readonly shared: boolean
  readonly receivedAt: number
  readonly bodyExpiresAt: number
  /** The next timeout, as `jobs:due` holds it; absent once the job ended. */
  readonly due?: number
  readonly route?: JobRoute
  /** Where an offered job goes back to when no computer takes it: the queue until then, else it expires. */
  readonly queueUntil?: number
  readonly offeredAt?: number
  /** Declines in the current offer round. */
  readonly declines?: readonly JobDecline[]
  readonly device?: string
  readonly lease?: JobLease
  readonly claimedAt?: number
  readonly startedAt?: number
  readonly limits?: JobLimits
  readonly seq?: number
  readonly milestone?: Milestone
  readonly files?: number
  readonly lastReportAt?: number
  readonly dispatchedAt?: number
  readonly ticketHash?: string
  readonly rid?: string
  readonly outcome?: Outcome
  /** Why a job was refused. */
  readonly code?: RefusalCode | DeclineCode
  /** How a job ended without a result. */
  readonly ending?: Ending
  readonly result?: JobResult
  /** The settle summary, sealed; erased once posted (3.2). */
  readonly summaryEnc?: string
  /** The platform's reply references (channel, thread, session), sealed. */
  readonly replyEnc?: string
  readonly endedAt?: number
}

/**
 * What lives only as long as the job's body (at most 2 hours, sealed): the requester's own words, the untrusted
 * context, and the requester's display name, sanitized, which the computer may show but never puts in the task.
 */
export type JobBody = { readonly task: string; readonly context: readonly UntrustedItem[]; readonly label: string }

const RECORD_FIELDS = new Set([
  "version",
  "state",
  "jid",
  "platform",
  "installation",
  "kind",
  "requester",
  "sponsor",
  "repository",
  "issue",
  "github",
  "shared",
  "receivedAt",
  "bodyExpiresAt",
  "due",
  "route",
  "queueUntil",
  "offeredAt",
  "declines",
  "device",
  "lease",
  "claimedAt",
  "startedAt",
  "limits",
  "seq",
  "milestone",
  "files",
  "lastReportAt",
  "dispatchedAt",
  "ticketHash",
  "rid",
  "outcome",
  "code",
  "ending",
  "result",
  "summaryEnc",
  "replyEnc",
  "endedAt",
])

const RID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const TICKET_HASH_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const SEALED_PATTERN = /^ves1\.[A-Za-z0-9_.-]{1,200000}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function optional(value: unknown, check: (value: unknown) => boolean) {
  return value === undefined || check(value)
}

function oneOf(list: readonly string[]) {
  return (value: unknown) => typeof value === "string" && list.includes(value)
}

function matches(pattern: RegExp) {
  return (value: unknown) => typeof value === "string" && pattern.test(value)
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= LIMITS.files
}

function leaseValid(value: unknown) {
  return isObject(value) && matches(RANDOM_ID_PATTERN)(value.id) && isTime(value.expiresAt)
}

function limitsValid(value: unknown) {
  return (
    isObject(value) &&
    typeof value.maxUsd === "number" &&
    value.maxUsd > 0 &&
    typeof value.minutes === "number" &&
    value.minutes > 0 &&
    isTime(value.deadline)
  )
}

function resultValid(value: unknown) {
  return (
    isObject(value) &&
    optional(value.branch, matches(BRANCH_PATTERN)) &&
    optional(value.prUrl, matches(PR_URL_PATTERN)) &&
    optional(value.headSha, matches(HEAD_SHA_PATTERN)) &&
    optional(value.files, count) &&
    optional(value.checks, (checks) => checks === "skipped") &&
    optional(
      value.needs,
      (needs) => Array.isArray(needs) && needs.length <= LIMITS.needs && needs.every(matches(PERMISSION_ID_PATTERN)),
    )
  )
}

/** A stored job record, checked field by field; anything else (an unknown field included) is undefined. */
export function decodeJobRecord(value: unknown): JobRecord | undefined {
  if (!isObject(value)) return undefined
  for (const field of Object.keys(value)) if (!RECORD_FIELDS.has(field)) return undefined
  const platform = value.platform
  if (!oneOf(PLATFORMS)(platform)) return undefined
  const requester = value.requester
  const repository = value.repository
  const github = value.github
  const ok =
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version >= 1 &&
    oneOf(JOB_STATES)(value.state) &&
    matches(JOB_ID_PATTERN)(value.jid) &&
    installationPlatform(value.installation) === platform &&
    oneOf(JOB_KINDS)(value.kind) &&
    isObject(requester) &&
    typeof requester.userId === "string" &&
    userIdValid(value.installation as string, requester.userId) &&
    matches(ACCOUNT_ID_PATTERN)(requester.account) &&
    Object.keys(requester).length === 2 &&
    matches(ACCOUNT_ID_PATTERN)(value.sponsor) &&
    isObject(repository) &&
    typeof repository.id === "number" &&
    Number.isSafeInteger(repository.id) &&
    repository.id > 0 &&
    isRepositoryName(repository.fullName) &&
    typeof repository.shared === "boolean" &&
    optional(value.issue, (issue) => isObject(issue) && isIssueKey(issue.key)) &&
    optional(
      github,
      (reference) =>
        isObject(reference) &&
        (reference.kind === "issue" || reference.kind === "pr") &&
        typeof reference.number === "number" &&
        Number.isSafeInteger(reference.number) &&
        reference.number > 0 &&
        optional(reference.commentId, (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0),
    ) &&
    typeof value.shared === "boolean" &&
    isTime(value.receivedAt) &&
    isTime(value.bodyExpiresAt) &&
    optional(value.due, isTime) &&
    optional(value.route, oneOf(["laptop", "actions", "queue"])) &&
    optional(value.queueUntil, isTime) &&
    optional(value.offeredAt, isTime) &&
    optional(
      value.declines,
      (declines) =>
        Array.isArray(declines) &&
        declines.length <= 32 &&
        declines.every(
          (entry) => isObject(entry) && matches(DEVICE_ID_PATTERN)(entry.device) && oneOf(DECLINE_CODES)(entry.reason),
        ),
    ) &&
    optional(value.device, matches(DEVICE_ID_PATTERN)) &&
    optional(value.lease, leaseValid) &&
    optional(value.claimedAt, isTime) &&
    optional(value.startedAt, isTime) &&
    optional(value.limits, limitsValid) &&
    optional(value.seq, isTime) &&
    optional(value.milestone, oneOf(MILESTONES)) &&
    optional(value.files, count) &&
    optional(value.lastReportAt, isTime) &&
    optional(value.dispatchedAt, isTime) &&
    optional(value.ticketHash, matches(TICKET_HASH_PATTERN)) &&
    optional(value.rid, matches(RID_PATTERN)) &&
    optional(value.outcome, oneOf(OUTCOMES)) &&
    optional(value.code, oneOf([...REFUSAL_CODES, ...DECLINE_CODES])) &&
    optional(value.ending, oneOf(ENDINGS)) &&
    optional(value.result, resultValid) &&
    optional(value.summaryEnc, matches(SEALED_PATTERN)) &&
    optional(value.replyEnc, matches(SEALED_PATTERN)) &&
    optional(value.endedAt, isTime)
  return ok ? (value as JobRecord) : undefined
}

/** The record as stored: `version` and `state` first, which the transition script reads by pattern. */
export function encodeJobRecord(record: JobRecord): string {
  const { version, state, ...rest } = record
  const text = JSON.stringify({ version, state, ...rest })
  if (!text.startsWith(`{"version":${version},"state":"${state}"`)) throw new TypeError("A job record is malformed.")
  return text
}

/**
 * A stored job record that does not decode: damage, or a record a newer deployment wrote (a field this one does not
 * know, after a rollback). Routes answer it as the store being unavailable (503); the sweep and erase tell it apart, so
 * one such record never stalls the others.
 */
class UndecodableJob extends ApiError {
  constructor() {
    const base = storeUnavailable()
    super(base.statusCode, base.code, base.message)
  }
}

/** A job record, or undefined when there is none. A stored record that does not decode throws (503). */
export async function readJob(store: Store, jid: string): Promise<JobRecord | undefined> {
  if (!JOB_ID_PATTERN.test(jid)) return undefined
  const raw = await getValue(store, everywhereKeys.job(jid))
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UndecodableJob()
  }
  const job = decodeJobRecord(parsed)
  if (!job) throw new UndecodableJob()
  return job
}

/** A step that failed for one job only: logged with its fixed name, the job id and an error code, never a message. */
function report(step: string, error: unknown, jid?: string) {
  const code =
    error instanceof UndecodableJob
      ? "undecodable"
      : error instanceof ApiError
        ? error.code
        : error instanceof Busy
          ? "busy"
          : "error"
  console.error("Vector everywhere: a jobs step failed", { step, ...(jid ? { jid } : {}), code })
}

function decodeBody(value: unknown): JobBody | undefined {
  if (!isObject(value) || typeof value.task !== "string" || !Array.isArray(value.context)) return undefined
  if (typeof value.label !== "string" || value.label.length > LIMITS.requesterLabelChars) return undefined
  if (Object.keys(value).some((field) => field !== "task" && field !== "context" && field !== "label")) return undefined
  const context: UntrustedItem[] = []
  for (const item of value.context) {
    if (!isObject(item) || !oneOf(CONTEXT_SOURCES)(item.from) || typeof item.text !== "string") return undefined
    context.push({ from: item.from as UntrustedItem["from"], text: item.text })
  }
  return { task: value.task, context, label: value.label }
}

function bodyContext(jid: string) {
  return everywhereKeys.jobBody(jid)
}

function summaryContext(jid: string) {
  return `${everywhereKeys.job(jid)}:summary`
}

function replyContext(jid: string) {
  return `${everywhereKeys.job(jid)}:reply`
}

// ---------------------------------------------------------------------------------------------------------------------
// Context, timings and the job a computer receives
// ---------------------------------------------------------------------------------------------------------------------

export type JobsContext = {
  readonly store: Store
  /** The data key ring (`readConfig().dataKeys`): bodies, summaries and reply references are sealed under it. */
  readonly keys: readonly DataKey[]
  readonly now: number
  /** The offer signing key; without it nothing is offered. */
  readonly offer?: OfferKey
}

/** When a job's next timeout falls, from its state (3.4). Ended jobs have none. */
export function dueOf(record: Omit<JobRecord, "version">): number | undefined {
  switch (record.state) {
    case "received":
      return record.receivedAt + RECEIVED_STALE_MS
    case "offered":
      return (record.offeredAt ?? record.receivedAt) + TIMING.offerTtlMs
    case "claimed":
      return record.lease?.expiresAt ?? record.receivedAt
    case "running":
      return record.route === "actions"
        ? (record.startedAt ?? record.receivedAt) + ACTIONS_OVERDUE_MS
        : (record.lease?.expiresAt ?? record.receivedAt)
    case "dispatched":
      return (record.dispatchedAt ?? record.receivedAt) + TIMING.dispatchStartMs
    case "waiting":
      return Math.min(record.queueUntil ?? record.bodyExpiresAt, record.bodyExpiresAt)
    default:
      return undefined
  }
}

/**
 * The server's own limits for a claimed job: the computer applies the lower of these and its own caps (3.9), so the
 * server sends the highest values a computer's settings accept, except for Jira, whose job must end before 50 minutes
 * from intake whatever the computer allows (4.4): at most 35 minutes running.
 */
export function jobLimits(platform: PlatformId, receivedAt: number, claimedAt: number): JobLimits {
  const maxUsd = COMPUTER_CAPS.maxUsd.max
  if (platform === "jira") {
    const deadline = Math.min(claimedAt + TIMING.jiraRunMs, receivedAt + TIMING.jiraEndMs)
    return { maxUsd, minutes: Math.max(1, Math.floor((deadline - claimedAt) / 60_000)), deadline }
  }
  const minutes = COMPUTER_CAPS.minutes.max
  return { maxUsd, minutes, deadline: claimedAt + minutes * 60_000 }
}

/** The branch a job's settle must name: the same rule as core everywhere/publish.ts `branchFor`. */
export function expectedBranch(record: Pick<JobRecord, "jid" | "platform" | "issue">) {
  const issue = record.issue
  if (issue && (record.platform === "linear" || record.platform === "jira")) {
    const key = record.platform === "linear" ? issue.key.toLowerCase() : issue.key
    return `vector/ve-${key}-${record.jid.slice(-8)}`
  }
  return `vector/ve-${record.jid.slice(-12)}`
}

/** The job a computer receives on a claim (3.3): ids, the repository, the body and its lease. No token, no sponsor. */
export function claimedJob(record: JobRecord, body: JobBody, lease: JobLease, limits: JobLimits): EverywhereJob {
  return {
    v: 1,
    jid: record.jid,
    platform: record.platform,
    kind: record.kind,
    requester: { label: body.label, self: record.requester.account === record.sponsor },
    repository: { ...record.repository },
    ...(record.issue ? { issue: { key: record.issue.key } } : {}),
    task: body.task,
    context: body.context.map((item) => ({ from: item.from, text: item.text })),
    ...(record.github ? { github: { ...record.github } } : {}),
    limits: { ...limits },
    reply: { format: REPLY_FORMAT[record.platform], maxChars: LIMITS.summaryChars },
    lease: { ...lease },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Creates a job: the record (only when no record has its id), the sealed body with its 2-hour expiry, and the four
 * indexes; refused while the sponsor already has as many live jobs as the cap allows. KEYS: job, body, due, the
 * sponsor's live set, the installation's live set, the sponsor's history. ARGV: record, record TTL, sealed body, body
 * TTL, due score, jid, received score, live cap, history cutoff, history TTL. Answers 1, 0 (the id exists) or -3 (the
 * live cap is full).
 */
export const CREATE_JOB_SCRIPT = [
  "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end",
  "if redis.call('ZCARD', KEYS[4]) >= tonumber(ARGV[8]) then return -3 end",
  "redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])",
  "redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[4])",
  "redis.call('ZADD', KEYS[3], ARGV[5], ARGV[6])",
  "redis.call('ZADD', KEYS[4], ARGV[7], ARGV[6])",
  "redis.call('ZADD', KEYS[5], ARGV[7], ARGV[6])",
  "redis.call('ZADD', KEYS[6], ARGV[7], ARGV[6])",
  "redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', '(' .. ARGV[9])",
  "redis.call('PEXPIRE', KEYS[6], ARGV[10])",
  "return 1",
].join(" ")

/**
 * One state change, fenced: it writes only while the record still starts with the version and state it was read
 * with. KEYS: job, body, due, the sponsor's live set, the installation's live set. ARGV: expected version, expected
 * state, the next record, its TTL, the next due score ('' leaves `jobs:due`), '1' to stay live or '0' to leave both
 * live sets, the body ('keep', 'delete', or 'require': only while the body still exists), jid. Answers 1, 0 (no
 * record), -1 (someone changed it first) or -2 (the body is gone).
 */
export const TRANSITION_SCRIPT = [
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  'local version, state = string.match(raw, \'^{"version":(%d+),"state":"([a-z]+)"\')',
  "if version ~= ARGV[1] or state ~= ARGV[2] then return -1 end",
  "if ARGV[7] == 'require' and redis.call('EXISTS', KEYS[2]) == 0 then return -2 end",
  "redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])",
  "if ARGV[5] == '' then redis.call('ZREM', KEYS[3], ARGV[8]) else redis.call('ZADD', KEYS[3], ARGV[5], ARGV[8]) end",
  "if ARGV[6] == '0' then redis.call('ZREM', KEYS[4], ARGV[8]) redis.call('ZREM', KEYS[5], ARGV[8]) end",
  "if ARGV[7] == 'delete' then redis.call('DEL', KEYS[2]) end",
  "if ARGV[9] ~= '' then redis.call('ZADD', KEYS[6], ARGV[9], ARGV[8]) end",
  "return 1",
].join(" ")

function recordTtl(record: Pick<JobRecord, "receivedAt">, now: number) {
  return Math.max(60_000, record.receivedAt + KEEP_MS.job - now)
}

type Next = Omit<JobRecord, "version" | "due">
type BodyMode = "keep" | "delete" | "require"

/** What a step decides after reading the job: answer at once, or write `next` and then answer. */
type Decision<T> =
  | { readonly answer: T }
  | { readonly next: Next; readonly body?: BodyMode; readonly done: (written: JobRecord) => T }

class Busy extends Error {}

/**
 * Reads the job, lets `step` decide, and writes the decision fenced by the version it read. When another change won
 * the race, it reads again and decides again, so the step always acts on the record as it is.
 */
async function change<T>(
  ctx: JobsContext,
  jid: string,
  step: (job: JobRecord) => Promise<Decision<T>> | Decision<T>,
  missing: () => T,
): Promise<T> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const job = await readJob(ctx.store, jid)
    if (!job) return missing()
    const decision = await step(job)
    if ("answer" in decision) return decision.answer
    const terminal = TERMINAL_STATES.has(decision.next.state)
    const due = terminal ? undefined : dueOf(decision.next)
    const written = { ...decision.next, version: job.version + 1, ...(due === undefined ? {} : { due }) } as JobRecord
    const body: BodyMode = terminal ? "delete" : (decision.body ?? "keep")
    const result = storeInteger(
      await runScript(
        ctx.store,
        TRANSITION_SCRIPT,
        [
          everywhereKeys.job(jid),
          everywhereKeys.jobBody(jid),
          everywhereKeys.jobsDue(),
          everywhereKeys.jobs(job.sponsor),
          everywhereKeys.installationJobs(job.installation),
          everywhereKeys.jobsPosts(),
        ],
        [
          job.version,
          job.state,
          encodeJobRecord(written),
          recordTtl(job, ctx.now),
          due === undefined ? "" : due,
          terminal ? "0" : "1",
          body,
          jid,
          terminal && !TERMINAL_STATES.has(job.state) ? ctx.now : "",
        ],
      ),
    )
    if (result === 1) return decision.done(written)
    if (result === 0) return missing()
    if (result !== -1 && result !== -2) throw storeUnavailable()
  }
  throw new Busy()
}

/** The next record of a job that ends now. Its device and lease stay, so its computer still hears how it ended. */
function ended(job: JobRecord, state: JobState, now: number, extra: Partial<Next> = {}): Next {
  const { version: _version, due: _due, ...rest } = job
  return { ...rest, state, endedAt: now, ...extra }
}

function next(job: JobRecord, extra: Partial<Next>): Next {
  const { version: _version, due: _due, ...rest } = job
  return { ...rest, ...extra }
}

function withoutKeys<T extends object>(value: T, ...keys: readonly (keyof T)[]): T {
  const copy = { ...value }
  for (const key of keys) delete copy[key]
  return copy
}

/**
 * Records a change that is already written. Best effort: the change happened, so a failed append is logged and never
 * turns it into an error. Otherwise the route would answer 503 and skip its platform post, and the retry would find
 * the job already moved (a settle answered `fresh: false`, a decline 409), so the result or the fixed reply would never
 * be posted, and a sweep's ending would never be announced.
 */
async function audit(ctx: JobsContext, job: JobRecord, entry: Omit<AuditInput, "platform" | "installation" | "jid">) {
  try {
    await appendAudit(
      ctx.store,
      job.sponsor,
      { platform: job.platform, installation: job.installation, jid: job.jid, ...entry },
      ctx.now,
    )
  } catch (error) {
    report(`audit-${entry.event}`, error, job.jid)
  }
}

/** A change lost the race too many times in a row: the store is busy, answered as unavailable. */
export function isBusy(error: unknown) {
  return error instanceof Busy
}

// ---------------------------------------------------------------------------------------------------------------------
// Creating a job
// ---------------------------------------------------------------------------------------------------------------------

export type NewJob = {
  readonly platform: PlatformId
  readonly installation: string
  readonly kind: JobKind
  readonly requester: { readonly userId: string; readonly account: string; readonly label?: string }
  readonly sponsor: string
  readonly repository: { readonly id: number; readonly fullName: string; readonly shared: boolean }
  readonly issue?: { readonly key: string }
  readonly github?: { readonly kind: "issue" | "pr"; readonly number: number; readonly commentId?: number }
  readonly shared: boolean
  readonly task: string
  readonly context: readonly UntrustedItem[]
  /** The platform's reply references (channel, thread, session ids): sealed, never shown to a computer. */
  readonly reply?: Readonly<Record<string, string | number | boolean | null>>
}

export type CreateVerdict =
  | { readonly ok: true; readonly job: JobRecord }
  | { readonly ok: false; readonly code: "over-limit" }
  | { readonly ok: false; readonly code: "invalid"; readonly error: string }

/**
 * Creates a job in `received`, with its sealed body (2 hours) and its indexes, and records `job-accepted`. The body is
 * checked with the same decoder a computer runs on a claim, so a job a computer would refuse is never made: an empty
 * task (except GitHub, whose thread the computer reads itself), text on a GitHub job, too much context, a malformed
 * repository or issue key. Refused `over-limit` while the sponsor has 3 live jobs.
 */
export async function createJob(ctx: JobsContext, input: NewJob, options: { readonly jid?: string } = {}) {
  const jid = options.jid ?? createJobId(ctx.now)
  const invalid = (error: string): CreateVerdict => ({ ok: false, code: "invalid", error })
  if (!JOB_ID_PATTERN.test(jid)) return invalid("jid: malformed")
  if (installationPlatform(input.installation) !== input.platform) return invalid("installation: malformed")
  if (!(JOB_KINDS as readonly string[]).includes(input.kind)) return invalid("kind: not allowed")
  if (!userIdValid(input.installation, input.requester.userId)) return invalid("requester.userId: malformed")
  if (!ACCOUNT_ID_PATTERN.test(input.requester.account)) return invalid("requester.account: malformed")
  if (!ACCOUNT_ID_PATTERN.test(input.sponsor)) return invalid("sponsor: malformed")
  if (!ctx.keys.length) return invalid("data key: missing")

  const record: JobRecord = {
    version: 1,
    state: "received",
    jid,
    platform: input.platform,
    installation: input.installation,
    kind: input.kind,
    requester: { userId: input.requester.userId, account: input.requester.account.toLowerCase() },
    sponsor: input.sponsor.toLowerCase(),
    repository: { id: input.repository.id, fullName: input.repository.fullName, shared: input.repository.shared },
    ...(input.issue ? { issue: { key: input.issue.key } } : {}),
    ...(input.github ? { github: { ...input.github } } : {}),
    shared: input.shared,
    receivedAt: ctx.now,
    bodyExpiresAt: ctx.now + KEEP_MS.jobBody,
    due: ctx.now + RECEIVED_STALE_MS,
    ...(input.reply ? { replyEnc: sealJson(ctx.keys, input.reply, replyContext(jid)) } : {}),
  }
  const body: JobBody = { task: input.task, context: input.context, label: sanitizeLabel(input.requester.label ?? "") }
  // The same checks a computer runs, on a stand-in lease: a job a computer would refuse is never created.
  const check = decodeJob(
    claimedJob(
      record,
      body,
      { id: randomId(), expiresAt: ctx.now + TIMING.leaseMs },
      jobLimits(record.platform, ctx.now, ctx.now),
    ),
  )
  if (!check.ok) return invalid(check.error)
  if (!decodeJobRecord(JSON.parse(encodeJobRecord(record)))) return invalid("record: malformed")

  const result = storeInteger(
    await runScript(
      ctx.store,
      CREATE_JOB_SCRIPT,
      [
        everywhereKeys.job(jid),
        everywhereKeys.jobBody(jid),
        everywhereKeys.jobsDue(),
        everywhereKeys.jobs(record.sponsor),
        everywhereKeys.installationJobs(record.installation),
        everywhereKeys.jobHistory(record.sponsor),
      ],
      [
        encodeJobRecord(record),
        KEEP_MS.job,
        sealJson(ctx.keys, body, bodyContext(jid)),
        KEEP_MS.jobBody,
        record.due ?? ctx.now,
        jid,
        record.receivedAt,
        SERVER_CAPS.sponsorLive,
        ctx.now - KEEP_MS.job,
        KEEP_MS.job,
      ],
    ),
  )
  if (result === -3) return { ok: false, code: "over-limit" } satisfies CreateVerdict
  if (result === 0) return invalid("jid: exists")
  if (result !== 1) throw storeUnavailable()
  await audit(ctx, record, { event: "job-accepted" })
  return { ok: true, job: record } satisfies CreateVerdict
}

/** The job's body (task and context), or undefined once it expired or the job ended. */
export async function readJobBody(ctx: JobsContext, jid: string): Promise<JobBody | undefined> {
  const sealed = await getValue(ctx.store, everywhereKeys.jobBody(jid))
  if (sealed === undefined) return undefined
  const opened = openJson(ctx.keys, sealed, bodyContext(jid), decodeBody)
  return opened.ok ? opened.value : undefined
}

/** The platform's reply references sealed at creation, for the adapters (VE-06). */
export function openReply(ctx: Pick<JobsContext, "keys">, job: JobRecord) {
  if (!job.replyEnc) return undefined
  const opened = openJson(ctx.keys, job.replyEnc, replyContext(job.jid), (value) =>
    isObject(value) ? (value as Readonly<Record<string, string | number | boolean | null>>) : undefined,
  )
  return opened.ok ? opened.value : undefined
}

/** The settle summary, for posting once (VE-06); `clearSummary` erases it afterwards. */
export function openSummary(ctx: Pick<JobsContext, "keys">, job: JobRecord) {
  if (!job.summaryEnc) return undefined
  const opened = openJson(ctx.keys, job.summaryEnc, summaryContext(job.jid), (value) =>
    typeof value === "string" ? value : undefined,
  )
  return opened.ok ? opened.value : undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// Routing changes the intake makes (VE-06 decides; these only move the job)
// ---------------------------------------------------------------------------------------------------------------------

export type Moved =
  | { readonly ok: true; readonly job: JobRecord }
  | { readonly ok: false; readonly state?: JobState; readonly code: "not-found" | "wrong-state" | "no-offer-key" }

const notFound = (): Moved => ({ ok: false, code: "not-found" })
const wrongState = (job: JobRecord): Moved => ({ ok: false, state: job.state, code: "wrong-state" })

/**
 * Offers a job to the sponsor's computers: `received` or `waiting` to `offered`, the declines of any earlier round
 * cleared, and a signed offer for 30 seconds. `queueUntil` says where the job goes when nobody claims it: back to the
 * queue until then (a waiting job keeps its own), otherwise it expires. Nothing is offered without a signing key.
 */
export async function offerJob(
  ctx: JobsContext,
  jid: string,
  options: { readonly queueUntil?: number } = {},
): Promise<
  (Moved & { readonly ok: false }) | { readonly ok: true; readonly job: JobRecord; readonly offer: SignedOffer }
> {
  const key = ctx.offer
  if (!key) return { ok: false, code: "no-offer-key" }
  const moved = await change<Moved>(
    ctx,
    jid,
    (job) => {
      if (job.state !== "received" && job.state !== "waiting") return { answer: wrongState(job) }
      const until = job.state === "waiting" ? job.queueUntil : options.queueUntil
      const limit = Math.min(queueDeadline(job.platform, job.receivedAt), job.bodyExpiresAt)
      const base = withoutKeys(next(job, { state: "offered", offeredAt: ctx.now, declines: [] }), "queueUntil")
      return {
        next: until !== undefined && until > ctx.now ? { ...base, queueUntil: Math.min(until, limit) } : base,
        done: (written) => ({ ok: true, job: written }),
      }
    },
    notFound,
  )
  if (!moved.ok) return moved
  await audit(ctx, moved.job, { event: "offer" })
  return { ok: true, job: moved.job, offer: signOffer(key, { account: moved.job.sponsor, jid, now: ctx.now }) }
}

/** Puts a job in the queue: `received` or `offered` to `waiting` until `until`, never past the queue's own limit. */
export async function queueJob(ctx: JobsContext, jid: string, until: number): Promise<Moved> {
  const moved = await change<Moved>(
    ctx,
    jid,
    (job) => {
      if (job.state !== "received" && job.state !== "offered") return { answer: wrongState(job) }
      const limit = Math.min(queueDeadline(job.platform, job.receivedAt), job.bodyExpiresAt)
      const queueUntil = Math.min(until, limit)
      if (!(queueUntil > ctx.now)) return { answer: wrongState(job) }
      return {
        next: withoutKeys(next(job, { state: "waiting", route: "queue", queueUntil }), "device", "lease"),
        done: (written) => ({ ok: true, job: written }),
      }
    },
    notFound,
  )
  if (moved.ok) await audit(ctx, moved.job, { event: "route", code: "queue" })
  return moved
}

/**
 * Hands a job to the binder's GitHub Actions: `received` or `offered` to `dispatched`, with @vector's ticket hash
 * (R-A1), which `ticket:<hash>` maps back to the job for the start hook. A claim after this gets 409, and a job any
 * computer ever claimed is never dispatched (3.4: the laptop never hands a claimed job to Actions).
 */
export async function dispatchJob(
  ctx: JobsContext,
  jid: string,
  input: { readonly ticketHash: string },
): Promise<Moved> {
  if (!TICKET_HASH_PATTERN.test(input.ticketHash)) return { ok: false, code: "wrong-state" }
  if (!JOB_ID_PATTERN.test(jid)) return notFound()
  // The ticket goes first, so a dispatch that went through can always be found by the start hook. It is harmless when
  // the dispatch below loses: `startDispatched` also requires the job to be `dispatched` with this very ticket.
  await setValue(ctx.store, everywhereKeys.ticket(input.ticketHash), jid, { ttlMs: KEEP_MS.ticket })
  const moved = await change<Moved>(
    ctx,
    jid,
    (job) => {
      if (job.state !== "received" && job.state !== "offered") return { answer: wrongState(job) }
      if (job.claimedAt !== undefined || job.device !== undefined) return { answer: wrongState(job) }
      return {
        next: withoutKeys(
          next(job, { state: "dispatched", route: "actions", dispatchedAt: ctx.now, ticketHash: input.ticketHash }),
          "queueUntil",
        ),
        done: (written) => ({ ok: true, job: written }),
      }
    },
    notFound,
  )
  if (!moved.ok) return moved
  await audit(ctx, moved.job, { event: "route", code: "actions" })
  return moved
}

/** @vector's start hook (R-A2): the run for this ticket started, so `dispatched` becomes `running` with its run id. */
export async function startDispatched(ctx: JobsContext, ticketHash: string, rid: string): Promise<Moved> {
  if (!TICKET_HASH_PATTERN.test(ticketHash) || !RID_PATTERN.test(rid)) return notFound()
  const jid = await getValue(ctx.store, everywhereKeys.ticket(ticketHash))
  if (jid === undefined || !JOB_ID_PATTERN.test(jid)) return notFound()
  return change<Moved>(
    ctx,
    jid,
    (job) => {
      if (job.state !== "dispatched" || job.ticketHash !== ticketHash) return { answer: wrongState(job) }
      return {
        next: next(job, { state: "running", startedAt: ctx.now, rid }),
        done: (written) => ({ ok: true, job: written }),
      }
    },
    notFound,
  )
}

/** Refuses a job that was received, offered or claimed (lasting declines, a refusal found after intake). */
export async function refuseJob(ctx: JobsContext, jid: string, code: RefusalCode | DeclineCode): Promise<Moved> {
  const moved = await change<Moved>(
    ctx,
    jid,
    (job) => {
      if (job.state !== "received" && job.state !== "offered" && job.state !== "claimed")
        return { answer: wrongState(job) }
      return { next: ended(job, "refused", ctx.now, { code }), done: (written) => ({ ok: true, job: written }) }
    },
    notFound,
  )
  if (moved.ok) await audit(ctx, moved.job, { event: "job-refused", code })
  return moved
}

/** Cancels a live job (a platform stop, the user, the `stop` switch, an erase). A computer running it hears `stop`. */
export async function cancelJob(ctx: JobsContext, jid: string): Promise<Moved> {
  const moved = await change<Moved>(
    ctx,
    jid,
    (job) => {
      if (TERMINAL_STATES.has(job.state)) return { answer: wrongState(job) }
      return { next: ended(job, "cancelled", ctx.now), done: (written) => ({ ok: true, job: written }) }
    },
    notFound,
  )
  if (moved.ok) await audit(ctx, moved.job, { event: "settle", code: "cancelled" })
  return moved
}

/** Erases a posted summary from an ended job's record (3.2: erased once posted). */
export async function clearSummary(ctx: JobsContext, jid: string): Promise<boolean> {
  return change<boolean>(
    ctx,
    jid,
    (job) =>
      job.summaryEnc ? { next: withoutKeys(next(job, {}), "summaryEnc"), done: () => true } : { answer: false },
    () => false,
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// What computers do: claim, decline, report, settle
// ---------------------------------------------------------------------------------------------------------------------

export type Refused = {
  readonly ok: false
  readonly status: 400 | 404 | 409
  readonly code: string
  readonly reason?: string
  /** A claim that found the body gone ended the job: the adapters post its fixed reply. */
  readonly expired?: JobRecord
}

const NOT_FOUND: Refused = { ok: false, status: 404, code: "NOT_FOUND" }
const MISMATCH: Refused = { ok: false, status: 409, code: "LEASE_MISMATCH" }

function sponsored(job: JobRecord, account: string) {
  return job.sponsor === account.toLowerCase()
}

/** The job is held by this computer under this lease. */
function holds(job: JobRecord, device: string, lease: string | undefined) {
  return job.route === "laptop" && job.device === device && lease !== undefined && job.lease?.id === lease
}

export type ClaimVerdict =
  | { readonly ok: true; readonly job: EverywhereJob; readonly record: JobRecord; readonly fresh: boolean }
  | Refused

/**
 * A computer claims a job (3.5 step 3): only the sponsor's own computers (404 otherwise), and only an `offered` or
 * `waiting` job (409 `JOB_TAKEN` after a dispatch, another claim or its end). The claim takes a 5-minute lease and
 * answers the job with its body. A claim that finds the body gone ends the job `expired` (409 `JOB_EXPIRED`), so no
 * job ever starts without its task. The same computer claiming again gets the same job and lease back.
 */
export async function claimJob(
  ctx: JobsContext,
  input: { readonly account: string; readonly jid: string; readonly device: string },
): Promise<ClaimVerdict> {
  const verdict = await change<ClaimVerdict | { readonly gone: JobRecord }>(
    ctx,
    input.jid,
    async (job) => {
      if (!sponsored(job, input.account)) return { answer: NOT_FOUND }
      if (
        (job.state === "claimed" || job.state === "running") &&
        job.route === "laptop" &&
        job.device === input.device
      ) {
        const again = await readJobBody(ctx, job.jid)
        if (!again || !job.lease || !job.limits) return { answer: { ok: false, status: 409, code: "JOB_TAKEN" } }
        return { answer: { ok: true, job: claimedJob(job, again, job.lease, job.limits), record: job, fresh: false } }
      }
      if (job.state !== "offered" && job.state !== "waiting")
        return { answer: { ok: false, status: 409, code: "JOB_TAKEN" } }
      const body = ctx.now < job.bodyExpiresAt ? await readJobBody(ctx, job.jid) : undefined
      if (!body)
        return {
          next: ended(job, "expired", ctx.now, { outcome: "expired", ending: "expired" }),
          done: (written) => ({ gone: written }),
        }
      const lease = { id: randomId(), expiresAt: ctx.now + TIMING.leaseMs }
      const limits = jobLimits(job.platform, job.receivedAt, ctx.now)
      const decoded = decodeJob(claimedJob(job, body, lease, limits))
      if (!decoded.ok)
        return {
          next: ended(job, "failed", ctx.now),
          done: () => ({ ok: false, status: 409, code: "JOB_INVALID" }) as const,
        }
      return {
        // A claim is final, so the offer round's declines and the queue it would have gone back to are dropped.
        next: withoutKeys(
          next(job, { state: "claimed", route: "laptop", device: input.device, lease, claimedAt: ctx.now, limits }),
          "declines",
          "queueUntil",
        ),
        body: "require",
        done: (written) => ({ ok: true, job: decoded.value, record: written, fresh: true }),
      }
    },
    () => NOT_FOUND,
  )
  if ("gone" in verdict) {
    await audit(ctx, verdict.gone, { event: "settle", code: "expired" })
    return { ok: false, status: 409, code: "JOB_EXPIRED", expired: verdict.gone }
  }
  if (verdict.ok && verdict.fresh) await audit(ctx, verdict.record, { event: "claim", device: input.device })
  return verdict
}

export type DeclineVerdict = { readonly ok: true; readonly recorded: boolean; readonly job?: JobRecord } | Refused

/**
 * A computer turns a job down (3.4 step 5a, 3.5 steps 2 and 3, 4.1). Before a claim the decline is recorded for the
 * offer round the intake is waiting on, where a `busy` decline moves the job on and lasting ones refuse it. After a
 * claim (with its lease, `claimed` or `running`) the job ends `refused` with the decline's reason, whatever it is: a
 * claim is final, so a job a computer held never goes back to an offer, the queue or Actions (3.4, E8). For a GitHub
 * handoff the job's end answers `handled: false`, and @vector's own run goes on.
 */
export async function declineJob(
  ctx: JobsContext,
  input: {
    readonly account: string
    readonly jid: string
    readonly device: string
    readonly reason: DeclineCode
    readonly lease?: string
  },
): Promise<DeclineVerdict> {
  const verdict = await change<DeclineVerdict>(
    ctx,
    input.jid,
    (job) => {
      if (!sponsored(job, input.account)) return { answer: NOT_FOUND }
      const claimedHere = (job.state === "claimed" || job.state === "running") && job.device === input.device
      if (input.lease !== undefined || claimedHere) {
        if (!holds(job, input.device, input.lease)) return { answer: MISMATCH }
        if (job.state !== "claimed" && job.state !== "running") return { answer: MISMATCH }
        return {
          next: ended(job, "refused", ctx.now, { code: input.reason }),
          done: (written) => ({ ok: true, recorded: true, job: written }),
        }
      }
      if (job.state !== "offered") return { answer: { ok: true, recorded: false } }
      const declines = [...(job.declines ?? []).filter((entry) => entry.device !== input.device)]
      declines.push({ device: input.device, reason: input.reason })
      return {
        next: next(job, { declines: declines.slice(-32) }),
        done: (written) => ({ ok: true, recorded: true, job: written }),
      }
    },
    () => NOT_FOUND,
  )
  if (verdict.ok && verdict.recorded && verdict.job) {
    await audit(ctx, verdict.job, { event: "decline", device: input.device, code: input.reason })
    if (verdict.job.state === "refused") await audit(ctx, verdict.job, { event: "job-refused", code: input.reason })
  }
  return verdict
}

export type ReportAction = "continue" | "stop" | "lost"
export type ReportVerdict =
  | { readonly ok: true; readonly action: ReportAction; readonly leaseExpiresAt?: number; readonly job?: JobRecord }
  | Refused

/**
 * A milestone report or heartbeat from the computer holding the job (3.5 step 7). Only the sponsor's job (404), only
 * from the device and lease that claimed it (409). It renews the lease for 5 minutes and moves `claimed` to
 * `running`; a newer `seq` records the milestone and file count. A cancelled job, or one past its deadline, answers
 * `stop`; a lost one `lost`. The runner aborts and pushes nothing on either.
 */
export async function reportJob(
  ctx: JobsContext,
  input: { readonly account: string; readonly device: string; readonly report: Report },
): Promise<ReportVerdict> {
  const report = input.report
  return change<ReportVerdict>(
    ctx,
    report.jid,
    (job) => {
      if (!sponsored(job, input.account)) return { answer: NOT_FOUND }
      if (job.device !== input.device || job.lease?.id !== report.lease || job.route !== "laptop")
        return { answer: MISMATCH }
      if (job.state === "lost") return { answer: { ok: true, action: "lost" } }
      if (job.state === "cancelled") return { answer: { ok: true, action: "stop" } }
      if (job.state !== "claimed" && job.state !== "running")
        return { answer: { ok: false, status: 409, code: "JOB_ENDED" } }
      if (job.limits && ctx.now >= job.limits.deadline) return { answer: { ok: true, action: "stop" } }
      const newer = report.seq > (job.seq ?? -1)
      const lease = { id: report.lease, expiresAt: ctx.now + TIMING.leaseMs }
      return {
        next: next(job, {
          state: "running",
          lease,
          lastReportAt: ctx.now,
          ...(job.state === "claimed" ? { startedAt: ctx.now } : {}),
          ...(newer ? { seq: report.seq } : {}),
          ...(newer && report.milestone !== "heartbeat" ? { milestone: report.milestone } : {}),
          ...(newer && report.files !== undefined ? { files: report.files } : {}),
        }),
        done: (written) => ({ ok: true, action: "continue", leaseExpiresAt: lease.expiresAt, job: written }),
      }
    },
    () => NOT_FOUND,
  )
}

export type SettleVerdict = { readonly ok: true; readonly job: JobRecord; readonly fresh: boolean } | Refused

/**
 * The computer's result (3.5 step 8). Only the sponsor's job (404), from the device and lease holding it (409). The
 * PR link must point into the job's own repository and the branch must be the job's own (400). Settling records the
 * outcome and links, seals the summary until it is posted, and erases the body. A repeated settle from the same lease
 * answers as the first did.
 */
export async function settleJob(
  ctx: JobsContext,
  input: { readonly account: string; readonly device: string; readonly settle: Settle },
): Promise<SettleVerdict> {
  const settle = input.settle
  const verdict = await change<SettleVerdict>(
    ctx,
    settle.jid,
    (job) => {
      if (!sponsored(job, input.account)) return { answer: NOT_FOUND }
      if (!holds(job, input.device, settle.lease)) return { answer: MISMATCH }
      if (settle.prUrl !== undefined) {
        const repository = PR_URL_PATTERN.exec(settle.prUrl)?.[1] ?? ""
        if (repository.toLowerCase() !== job.repository.fullName.toLowerCase())
          return { answer: { ok: false, status: 400, code: "EVERYWHERE_INVALID", reason: "prUrl: other repository" } }
      }
      if (settle.branch !== undefined && settle.branch !== expectedBranch(job))
        return { answer: { ok: false, status: 400, code: "EVERYWHERE_INVALID", reason: "branch: not this job's" } }
      if (job.state === "settled") return { answer: { ok: true, job, fresh: false } }
      if (job.state !== "claimed" && job.state !== "running")
        return { answer: { ok: false, status: 409, code: "JOB_ENDED" } }
      const result: JobResult = {
        ...(settle.branch !== undefined ? { branch: settle.branch } : {}),
        ...(settle.prUrl !== undefined ? { prUrl: settle.prUrl } : {}),
        ...(settle.headSha !== undefined ? { headSha: settle.headSha } : {}),
        ...(settle.files !== undefined ? { files: settle.files } : {}),
        ...(settle.checks !== undefined ? { checks: settle.checks } : {}),
        ...(settle.needs !== undefined ? { needs: [...settle.needs] } : {}),
      }
      const summary =
        settle.summary !== undefined && settle.summary.trim() !== ""
          ? { summaryEnc: sealJson(ctx.keys, settle.summary, summaryContext(job.jid)) }
          : {}
      return {
        next: ended(job, "settled", ctx.now, { outcome: settle.outcome, result, ...summary }),
        done: (written) => ({ ok: true, job: written, fresh: true }),
      }
    },
    () => NOT_FOUND,
  )
  if (verdict.ok && verdict.fresh)
    await audit(ctx, verdict.job, { event: "settle", device: input.device, code: settle.outcome })
  return verdict
}

// ---------------------------------------------------------------------------------------------------------------------
// Timeouts: the sweep (VE-06's cron) and the lazy sweep every jobs call makes
// ---------------------------------------------------------------------------------------------------------------------

export type EndedJob = { readonly job: JobRecord; readonly ending?: Ending }
type Swept = { readonly job: JobRecord; readonly ended: boolean; readonly ending?: Ending }

/**
 * What a due job becomes (3.4): an unrouted job and a waiting one expire; an offer nobody claimed goes back to the
 * queue when it has one, else expires; a laptop job with no report for a lease length is `lost`; an Actions run past
 * its longest run fails; a dispatch with no start hook in 900 s fails (`not-started`). Under the `stop` switch every
 * live job ends at once: waiting ones expire and the rest are cancelled.
 */
function timeout(job: JobRecord, now: number, stop: boolean): Decision<Swept> | undefined {
  const expire = (ending: Ending = job.platform === "jira" ? "jira-waiting" : "expired"): Decision<Swept> => ({
    next: ended(job, "expired", now, { outcome: "expired", ending }),
    done: (written) => ({ job: written, ended: true, ending }),
  })
  if (TERMINAL_STATES.has(job.state)) return undefined
  if (stop) {
    if (job.state === "waiting" || job.state === "received" || job.state === "offered") return expire()
    return { next: ended(job, "cancelled", now), done: (written) => ({ job: written, ended: true }) }
  }
  const due = job.due ?? dueOf(job)
  if (due === undefined || due > now) return undefined
  switch (job.state) {
    case "received":
    case "waiting":
      return expire()
    case "offered": {
      const until = job.queueUntil
      if (until !== undefined && until > now && job.bodyExpiresAt > now)
        return {
          next: withoutKeys(next(job, { state: "waiting", route: "queue", queueUntil: until }), "device", "lease"),
          done: (written) => ({ job: written, ended: false }),
        }
      return expire()
    }
    case "claimed":
      return {
        next: ended(job, "lost", now, { ending: "lost" }),
        done: (written) => ({ job: written, ended: true, ending: "lost" as const }),
      }
    case "running":
      if (job.route === "actions")
        return { next: ended(job, "failed", now), done: (written) => ({ job: written, ended: true }) }
      return {
        next: ended(job, "lost", now, { ending: "lost" }),
        done: (written) => ({ job: written, ended: true, ending: "lost" as const }),
      }
    case "dispatched":
      return {
        next: ended(job, "failed", now, { ending: "not-started" }),
        done: (written) => ({ job: written, ended: true, ending: "not-started" as const }),
      }
    default:
      return undefined
  }
}

/**
 * Sweeps one job of an index. A job whose record is gone (it expired before any sweep, or was erased) leaves the
 * indexes named, and its body goes, so it neither comes up again nor holds a place under the live cap.
 */
async function sweepOne(
  ctx: JobsContext,
  jid: string,
  stop: boolean,
  indexes: readonly string[],
): Promise<EndedJob | undefined> {
  let gone = false
  const swept = await change<Swept | undefined>(
    ctx,
    jid,
    (job) => timeout(job, ctx.now, stop) ?? { answer: undefined },
    () => {
      gone = true
      return undefined
    },
  )
  if (gone) {
    for (const key of indexes) await ctx.store(["ZREM", key, jid])
    await deleteKeys(ctx.store, everywhereKeys.jobBody(jid))
    await ctx.store(["ZREM", everywhereKeys.jobsPosts(), jid])
    return undefined
  }
  if (!swept?.ended) return undefined
  await audit(ctx, swept.job, { event: "settle", code: swept.job.state })
  return swept.ending ? { job: swept.job, ending: swept.ending } : { job: swept.job }
}

/**
 * Sweeps each job on its own: a job that fails (a record that does not decode, a change that kept losing) is logged
 * with its id and an error code and the rest go on, so one bad entry never stalls the sweep or an account's calls. A
 * record that does not decode keeps its place in the indexes: it may be a newer deployment's live job.
 */
async function sweepEach(
  ctx: JobsContext,
  jids: readonly string[],
  stop: boolean,
  indexes: readonly string[],
): Promise<EndedJob[]> {
  const done: EndedJob[] = []
  for (const jid of jids) {
    try {
      const result = await sweepOne(ctx, jid, stop, indexes)
      if (result) done.push(result)
    } catch (error) {
      report("sweep", error, jid)
    }
  }
  return done
}

function members(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw storeUnavailable()
  return value.filter((member): member is string => typeof member === "string" && JOB_ID_PATTERN.test(member))
}

/**
 * Ends or moves an account's due jobs: what every `pending`, `claim`, `decline`, `report` and `settle` call does
 * first, as the safety net beside the sweep cron (3.4). Answers the jobs that ended, for the adapters' fixed replies.
 */
export async function sweepAccount(
  ctx: JobsContext,
  account: string,
  options: { readonly stop?: boolean } = {},
): Promise<EndedJob[]> {
  const live = everywhereKeys.jobs(account)
  const jids = members(await ctx.store(["ZRANGE", live, 0, -1]))
  return sweepEach(ctx, jids, options.stop === true, [live, everywhereKeys.jobsDue()])
}

/**
 * The sweep (VE-06's per-minute cron): every job whose next timeout has passed, oldest first, at most `limit`. Under
 * the `stop` switch every live job is taken, due or not.
 */
export async function sweepDue(
  ctx: JobsContext,
  options: { readonly limit?: number; readonly stop?: boolean } = {},
): Promise<EndedJob[]> {
  const limit = options.limit ?? 200
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Pick 1 to 1,000.")
  const max = options.stop ? "+inf" : ctx.now
  const due = everywhereKeys.jobsDue()
  const jids = members(await ctx.store(["ZRANGEBYSCORE", due, "-inf", max, "LIMIT", 0, limit]))
  return sweepEach(ctx, jids, options.stop === true, [due])
}

// ---------------------------------------------------------------------------------------------------------------------
// Computers: when they were last seen and what they last said about themselves
// ---------------------------------------------------------------------------------------------------------------------

/** The readiness booleans a computer sends with each `pending` call (3.1 `status`). Nothing else about it is kept. */
export type Readiness = {
  /** "This computer takes jobs" is on. */
  readonly takesJobs: boolean
  /** Vector Remote is on. */
  readonly remote: boolean
  /** Vector Local is on (the runner then declines every job, E15). */
  readonly localMode: boolean
  /** The shell sandbox the runner needs for commands exists on this computer. */
  readonly sandbox: boolean
  /** "Wait for my computer" (default on). */
  readonly waitForComputer: boolean
  /** Today's caps on this computer have room. */
  readonly capsRoom: boolean
  /** At least one project is allowed. */
  readonly projects: boolean
}

export const READINESS_FIELDS = [
  "takesJobs",
  "remote",
  "localMode",
  "sandbox",
  "waitForComputer",
  "capsRoom",
  "projects",
] as const

type Seen = { readonly at: number; readonly device: string }

/** A JSON value that may be missing or damaged: either reads as undefined. For advisory records only. */
async function readSoft<T>(
  store: Store,
  key: string,
  decode: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  const raw = await getValue(store, key)
  if (raw === undefined) return undefined
  try {
    return decode(JSON.parse(raw))
  } catch {
    return undefined
  }
}
type Ready = Readiness & { readonly account: string; readonly at: number }

function decodeSeen(value: unknown): Seen | undefined {
  return isObject(value) && isTime(value.at) && matches(DEVICE_ID_PATTERN)(value.device)
    ? { at: value.at as number, device: value.device as string }
    : undefined
}

function decodeReady(value: unknown): Ready | undefined {
  if (!isObject(value) || !matches(ACCOUNT_ID_PATTERN)(value.account) || !isTime(value.at)) return undefined
  for (const field of READINESS_FIELDS) if (typeof value[field] !== "boolean") return undefined
  return value as Ready
}

/** Records that one of the account's computers called (`seen:<account>`, 30 days), and its readiness when it sent it. */
export async function recordSeen(
  ctx: Pick<JobsContext, "store" | "now">,
  account: string,
  device: string,
  readiness?: Readiness,
): Promise<void> {
  if (!DEVICE_ID_PATTERN.test(device)) throw new RangeError("A device id.")
  const owner = account.toLowerCase()
  await setJson(ctx.store, everywhereKeys.seen(owner), { at: ctx.now, device }, { ttlMs: KEEP_MS.seen })
  if (readiness) {
    const ready: Ready = { account: owner, at: ctx.now, ...pickReadiness(readiness) }
    await setJson(ctx.store, everywhereKeys.ready(owner, device), ready, { ttlMs: KEEP_MS.ready })
  }
}

function pickReadiness(readiness: Readiness): Readiness {
  return {
    takesJobs: readiness.takesJobs,
    remote: readiness.remote,
    localMode: readiness.localMode,
    sandbox: readiness.sandbox,
    waitForComputer: readiness.waitForComputer,
    capsRoom: readiness.capsRoom,
    projects: readiness.projects,
  }
}

/** When the account's computers were last seen and the last one's readiness, for the router and `status`. */
export async function readComputer(
  store: Store,
  account: string,
): Promise<{ readonly lastSeen?: number; readonly readiness?: Readiness }> {
  const owner = account.toLowerCase()
  const seen = await readSoft(store, everywhereKeys.seen(owner), decodeSeen)
  if (!seen) return {}
  const ready = await readSoft(store, everywhereKeys.ready(owner, seen.device), decodeReady)
  return ready && ready.account === owner
    ? { lastSeen: seen.at, readiness: pickReadiness(ready) }
    : { lastSeen: seen.at }
}

/**
 * What `pending` does for the account's waiting jobs (3.4): when this computer can take jobs right now, each waiting
 * job is offered again and its signed offer answered over HTTPS, so the computer claims it like any offered job.
 */
export async function offerWaiting(ctx: JobsContext, account: string): Promise<{ offers: string[]; waiting: number }> {
  const jids = members(await ctx.store(["ZRANGE", everywhereKeys.jobs(account), 0, -1]))
  const offers: string[] = []
  let waiting = 0
  for (const jid of jids) {
    // Each job on its own: one that fails is logged and the computer still hears of the others.
    try {
      const job = await readJob(ctx.store, jid)
      if (!job || job.state !== "waiting" || !sponsored(job, account)) continue
      waiting++
      const offered = await offerJob(ctx, jid)
      if (offered.ok) offers.push(offered.offer.offer)
    } catch (error) {
      report("offer-waiting", error, jid)
    }
  }
  return { offers, waiting }
}

// ---------------------------------------------------------------------------------------------------------------------
// Erasing (E13): the jobs half of erase.ts
// ---------------------------------------------------------------------------------------------------------------------

/** Cancels every live job on an installation and erases their bodies. */
export async function eraseInstallationJobs(ctx: JobsContext, installation: string): Promise<number> {
  const key = everywhereKeys.installationJobs(installation)
  let cancelled = 0
  for (const jid of members(await ctx.store(["ZRANGE", key, 0, -1]))) {
    try {
      const moved = await cancelJob(ctx, jid)
      if (moved.ok) cancelled++
    } catch (error) {
      if (!(error instanceof UndecodableJob)) throw error
      // A record this deployment cannot read is on this installation's live index, so it is this installation's job:
      // it goes, rather than stopping the erase for good.
      await deleteKeys(ctx.store, everywhereKeys.job(jid))
      await ctx.store(["ZREM", everywhereKeys.jobsDue(), jid])
    }
    // A job that is gone or already ended may still hold a body: erase it all the same.
    await deleteKeys(ctx.store, everywhereKeys.jobBody(jid))
  }
  await deleteKeys(ctx.store, key)
  return cancelled
}

/**
 * Erases everything the jobs module keeps for an account being deleted: its live jobs are cancelled, then every job
 * record and body of its last 30 days, its history and the readiness its last computer sent.
 */
export async function eraseAccountJobs(ctx: JobsContext, account: string): Promise<void> {
  const owner = account.toLowerCase()
  for (const jid of members(await ctx.store(["ZRANGE", everywhereKeys.jobs(owner), 0, -1]))) {
    try {
      await cancelJob(ctx, jid)
    } catch (error) {
      // A record this deployment cannot read is deleted with the history below.
      if (!(error instanceof UndecodableJob)) throw error
    }
  }
  const history = everywhereKeys.jobHistory(owner)
  for (const jid of members(await ctx.store(["ZRANGE", history, 0, -1]))) {
    const job = await readJob(ctx.store, jid).catch(() => undefined)
    if (job && job.sponsor !== owner) continue
    await deleteKeys(ctx.store, everywhereKeys.job(jid), everywhereKeys.jobBody(jid))
    await ctx.store(["ZREM", everywhereKeys.jobsDue(), jid])
    await ctx.store(["ZREM", everywhereKeys.jobsPosts(), jid])
  }
  const seen = await readSoft(ctx.store, everywhereKeys.seen(owner), decodeSeen)
  if (seen) await deleteKeys(ctx.store, everywhereKeys.ready(owner, seen.device))
  await deleteKeys(ctx.store, history, everywhereKeys.jobs(owner))
}

/** The `JobEraser` erase.ts and the account routes take (VE-04), over a store and a clock. */
export function jobEraser(store: Store, now: () => number = Date.now): JobEraser {
  return {
    installation: async (installation) => {
      await eraseInstallationJobs({ store, keys: [], now: now() }, installation)
    },
    account: (account) => eraseAccountJobs({ store, keys: [], now: now() }, account),
  }
}
