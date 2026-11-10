import { ENTITLEMENTS, type EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import { isPlanId, type PlanId } from "../../packages/schema/src/codium-plan.js"
import { Hosted } from "../../packages/schema/src/hosted.js"
import { HOSTED_ABUSE } from "./codium-limits.js"
import { notifyOwner } from "./codium-owner.js"
import type { Transition } from "./codium-provision.js"
import { readSnapshot } from "./codium-snapshot.js"
import { readSwitch } from "./codium-switches.js"
import { hostedAccess, readHostedMinutes } from "./hosted-entitlement.js"
import {
  chargeNightly,
  drainHostedSettles,
  eraseAccountHostedLedger,
  periodCharges,
  readLine,
  runningBlocks,
  trueUpCharge,
} from "./hosted-ledger.js"
import {
  COMPUTER_PREFIX,
  computerName,
  eraseAccountComputers,
  hostedProvider,
  isComputerName,
  reconcileHostedComputers,
  type ComputerInfo,
} from "./hosted-provider.js"
import {
  HOSTED_DISK_GB_MAX,
  HOSTED_SIZES,
  SNAPSHOT_GB_DAY_COST_MICRO,
  egressGbCostMicro,
  wholeMinutes,
  weightedMinuteCostMicro,
  VCPU_HOUR_MICRO,
  MEMORY_GB_HOUR_MICRO,
} from "./hosted-rates.js"
import {
  START_STALE_MS,
  TOKEN_REFRESH_MS,
  endHostedSession,
  eraseSessionArchives,
  hostedArchivesKey,
  hostedBeatKey,
  hostedComputersKey,
  hostedDiskDueKey,
  hostedEgressKey,
  hostedHandoffAlertKey,
  hostedHostdKey,
  hostedJobKey,
  hostedLeaseKey,
  hostedLiveKey,
  hostedModelKey,
  hostedNamesKey,
  hostedPagesKey,
  hostedRecentKey,
  hostedSessionKey,
  hostedSessionsKey,
  hostedSuspendKey,
  hostedSuspendedKey,
  hostedTrueUpKey,
  readBeat,
  readLeases,
  readModelRequest,
  readSessionRecord,
  readSuspension,
  refreshRunToken,
  renewHostedBlock,
  suspendHostedAccount,
  updateSessionRecord,
  utcDay,
  utcHour,
  wrapHostedSession,
  type SessionOptions,
  type SessionRecord,
} from "./hosted-sessions.js"
import { ApiError } from "./http.js"
import { drainDebitApplies } from "./model-plan-account.js"
import { persistentStore } from "./persistent-store.js"
import { codiumKey } from "./codium-keys.js"

/*
 * The cloud computer's background work (contract WP A53): the reaper (every minute), the nightly charges and
 * deletions (02:30 UTC), the drift check (every 10 minutes), the budget figure the budget workflow reads, and the
 * `hosted` provisioner that follows each account's plan (§4.4's cloud computer row).
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** The reaper holds the next block this long before the current one's minutes are up (it runs every minute). */
export const RENEW_AHEAD_MS = 3 * MINUTE
/** Accounts the drift check looks at: those with session activity in this window. */
const DRIFT_WINDOW_MS = 26 * HOUR
/** Live plan states that keep a computer's disk at the plan's own retention. */
const LIVE_PLAN_STATES = new Set(["active", "renewing", "paused"])

export type CronOptions = SessionOptions & { budgetMs?: number }

function store(command: readonly (string | number)[], fetcher: typeof fetch) {
  return persistentStore(command, fetcher)
}

// ── Due jobs (WP A55) ──────────────────────────────────────────────────────────────────────────────────────────────

type DueJobsRunner = (options: { fetcher: typeof fetch; clock: () => number; budgetMs: number }) => Promise<unknown>
let dueJobs: DueJobsRunner | undefined

/** Done by Morning (WP A55) registers how the reaper starts its due jobs (`hosted:jobs:due`). One runner only. */
export function registerHostedJobsRunner(runner: DueJobsRunner) {
  if (dueJobs) throw new Error("The hosted job runner is already registered.")
  dueJobs = runner
}

// ── The reaper ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReapResult = {
  sessions: number
  renewed: number
  wrapped: number
  stopped: number
  released: number
  retried: number
  settled: number
  reconcile: Awaited<ReturnType<typeof reconcileHostedComputers>> | { ran: false; reason: "error" }
  jobs: boolean
}

/**
 * The reaper (§4.19, every minute). In order: the ledger's settle queue and lapsed blocks (WP A51); every live session
 * (the plan's state and the owner's switch and holds, fair use, the daemon's heartbeat, idleness, the take-over limit,
 * the job's deadline, the next block or a wrap-up within five minutes, a fresh run token); the orphan reconciler
 * (WP A52, which acts every three minutes); due jobs (WP A55, once registered); and the pool's unapplied debits.
 */
export async function reapHostedSessions(options: CronOptions = {}): Promise<ReapResult> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const started = clock()
  const budget = options.budgetMs ?? 45_000
  const left = () => budget - (clock() - started)
  const result: ReapResult = {
    sessions: 0,
    renewed: 0,
    wrapped: 0,
    stopped: 0,
    released: 0,
    retried: 0,
    settled: 0,
    reconcile: { ran: false, reason: "error" },
    jobs: false,
  }
  const settles = await drainHostedSettles({ fetcher, clock, budgetMs: Math.min(15_000, Math.max(0, left())) }).catch(
    () => undefined,
  )
  result.settled = settles?.settled ?? 0
  const live = await store(["ZRANGE", hostedLiveKey(), 0, 499], fetcher)
  for (const id of Array.isArray(live) ? live : []) {
    if (typeof id !== "string" || left() <= 10_000) break
    result.sessions++
    const outcome = await reapSession(id, options).catch(() => "retried" as const)
    if (outcome !== "kept") result[outcome]++
  }
  result.reconcile = await reconcileHostedComputers({
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    fetcher,
    clock,
    budgetMs: Math.max(1_000, Math.min(20_000, left() - 5_000)),
  }).catch(() => ({ ran: false as const, reason: "error" as const }))
  if (dueJobs && left() > 5_000) {
    await dueJobs({ fetcher, clock, budgetMs: Math.min(15_000, left() - 3_000) }).catch(() => undefined)
    result.jobs = true
  }
  if (left() > 2_000)
    await drainDebitApplies({ fetcher, now: clock(), budgetMs: Math.min(5_000, left() - 1_000), limit: 20 }).catch(
      () => undefined,
    )
  return result
}

type Outcome = "kept" | "renewed" | "wrapped" | "stopped" | "released" | "retried"

/** Why a plan state or switch stops a session now. */
function stopReason(snapshot: EntitlementSnapshot | undefined, service: string): Hosted.EndReason {
  if (service === "stop" || service === "off") return "switch"
  if (snapshot?.state === "frozen") return "frozen"
  if (snapshot?.state === "ended" && snapshot.reason === "closing") return "closing"
  return "plan"
}

/** What one block-renewal refusal means for the session. */
function renewalReason(error: unknown): Hosted.EndReason | undefined {
  if (!(error instanceof ApiError)) return undefined
  switch (error.code) {
    case "HOSTED_HOURS_USED":
      return "hours"
    case "MODEL_PLAN_EXHAUSTED":
    case "MODEL_PLAN_DAILY_LIMIT":
      return "usage"
    case "MODEL_PLAN_RENEWING":
    case "MODEL_PLAN_REQUIRED":
    case "MODEL_PLAN_PAYMENT_REQUIRED":
    case "HOSTED_PAUSED":
    case "HOSTED_NOT_INCLUDED":
    case "MODEL_PLAN_ACCOUNT_CLOSING":
      return "plan"
    case "HOSTED_FROZEN":
    case "MODEL_PLAN_BLOCKED":
      return "frozen"
    case "HOSTED_SESSION_MOVED":
      return "lapsed"
  }
  // Store or provider trouble: try again next minute while the hold lasts.
  return error.statusCode >= 500 ? undefined : "lapsed"
}

/** One live session's pass. */
export async function reapSession(id: string, options: CronOptions = {}): Promise<Outcome> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const record = await readSessionRecord(id, fetcher)
  if (!record || record.state === "ended") {
    await store(["ZREM", hostedLiveKey(), id], fetcher)
    return "kept"
  }
  const end = async (reason: Hosted.EndReason): Promise<Outcome> => {
    try {
      const ended = await endHostedSession(record, reason, options)
      return ended.state === "ended" ? "stopped" : "retried"
    } catch {
      return "retried"
    }
  }
  if (record.state === "stopping") return end(record.reason ?? "stopped")
  const now = clock()
  if (record.state === "starting" && now - record.createdAt >= START_STALE_MS) return end("failed")

  const [snapshot, service, suspension] = await Promise.all([
    readSnapshot(record.account, fetcher),
    readSwitch("hosted", fetcher, { now }),
    readSuspension(record.account, fetcher),
  ])
  const access = hostedAccess(snapshot, service === "off" ? "stop" : service, now)
  if (suspension) return end(suspension.reason === "abuse" ? "abuse" : "frozen")
  if (access === "stop") return end(stopReason(snapshot, service))
  if (record.state === "starting") return "kept"

  const [beat, modelAt] = await Promise.all([readBeat(id, fetcher), readModelRequest(id, fetcher)])
  const abuse = await fairUse(record, snapshot, beat, modelAt, now, fetcher)
  if (abuse) {
    await suspendHostedAccount(record.account, { reason: "abuse", detail: abuse, at: now }, fetcher).catch(() => undefined)
    await notifyOwner(
      {
        kind: `hosted-abuse:${record.account}`,
        subject: "Vector cloud computer: an account was put on hold (fair use)",
        lines: [
          `A cloud computer session went past a fair-use limit (${abuse}), so it was stopped and the account's cloud`,
          "computer is on hold until you release it from the owner's hosted flags.",
          "",
          `Account: ${record.account}`,
          `Session: ${record.id}`,
        ],
        dedupeMs: 6 * HOUR,
      },
      fetcher,
    ).catch(() => undefined)
    return end("abuse")
  }
  if (beat?.done) return end("finished")
  // A session told to wrap up ends for that reason once its time is up, whatever else happened meanwhile.
  if (record.state === "wrapping" && record.wrapBy !== undefined && now >= record.wrapBy)
    return end(record.reason ?? "deadline")
  if (now >= record.stopBy) return end(record.state === "wrapping" ? (record.reason ?? "lapsed") : "lapsed")
  const lastBeat = beat?.at ?? (record.runningAt ?? record.createdAt) + Hosted.BOOT_GRACE_MS - Hosted.HEARTBEAT_LOST_MS
  if (now - lastBeat >= Hosted.HEARTBEAT_LOST_MS) return end("heartbeat")

  let current = record
  let outcome: Outcome = "kept"
  if (current.state === "takeover" && current.takeover && now >= current.takeover.until) {
    current = await updateSessionRecord(
      id,
      (value) => (value.state === "takeover" ? { ...value, state: "running", takeover: undefined, releasedAt: now } : undefined),
      { fetcher, clock },
    )
    outcome = "released"
  }
  if (current.state !== "takeover") {
    const last = Math.max(
      modelAt ?? 0,
      beat?.activeAt ?? 0,
      current.runningAt ?? current.createdAt,
      current.releasedAt ?? 0,
    )
    if (now - last >= Hosted.IDLE_MS) return end("idle")
  }
  if (current.state !== "wrapping") {
    if (access === "wrap") {
      await wrapHostedSession(current, now + Hosted.WRAP_MS, "plan", options)
      return "wrapped"
    }
    if (now >= current.deadline) {
      await wrapHostedSession(current, Math.min(current.deadline + Hosted.WRAP_MS, current.stopBy), "deadline", options)
      return "wrapped"
    }
    if (now >= current.endsAt - RENEW_AHEAD_MS && current.endsAt < current.deadline) {
      try {
        current = await renewHostedBlock(current, options)
        return "renewed"
      } catch (error) {
        const reason = renewalReason(error)
        if (reason) {
          await wrapHostedSession(current, Math.min(current.stopBy, now + Hosted.WRAP_MS), reason, options)
          return "wrapped"
        }
        if (now + Hosted.WRAP_MS >= current.stopBy) {
          await wrapHostedSession(current, current.stopBy, "lapsed", options)
          return "wrapped"
        }
        return "retried"
      }
    }
  }
  if (current.tokenUntil !== undefined && current.tokenUntil - now < TOKEN_REFRESH_MS && current.tokenUntil > now)
    await refreshRunToken(current, options).catch(() => undefined)
  return outcome
}

/**
 * §4.2's fair-use limits for one session, or undefined when none is passed: 600 page loads an hour (the account's),
 * egress outside the run-API host per day by plan (the account's), and 30 minutes above 80% CPU with no model request.
 */
async function fairUse(
  record: SessionRecord,
  snapshot: EntitlementSnapshot | undefined,
  beat: Awaited<ReturnType<typeof readBeat>>,
  modelAt: number | undefined,
  now: number,
  fetcher: typeof fetch,
) {
  const [pages, egress] = await Promise.all([
    store(["GET", hostedPagesKey(record.account, utcHour(now))], fetcher),
    store(["GET", hostedEgressKey(record.account, utcDay(now))], fetcher),
  ])
  if (Number(pages) > HOSTED_ABUSE.pageLoadsPerHour) return "page loads an hour"
  const plan = snapshot?.plan
  const egressCap =
    plan && plan in HOSTED_ABUSE.egressGbPerDay
      ? HOSTED_ABUSE.egressGbPerDay[plan as keyof typeof HOSTED_ABUSE.egressGbPerDay]
      : undefined
  if (egressCap !== undefined && Number(egress) > egressCap * 1_000_000_000) return "egress a day"
  if (
    beat?.busySince !== undefined &&
    now - beat.busySince >= HOSTED_ABUSE.busyCpu.minutes * MINUTE &&
    (modelAt === undefined || modelAt < beat.busySince)
  )
    return "busy processor with no model request"
  return undefined
}

// ── The provisioner ────────────────────────────────────────────────────────────────────────────────────────────────

/** The roster: accounts whose plan includes a cloud computer now (HASH account → JSON), for the budget and nightly job. */
export const hostedRosterKey = () => codiumKey("hosted", "roster")
/** The nightly job's cached figures per account (HASH account → JSON), read by the budget answer. */
export const hostedBudgetKey = () => codiumKey("hosted", "budget")
/** The nightly job's last provider readings per computer (HASH name → JSON). */
export const hostedUsageKey = () => codiumKey("hosted", "usage")

function liveHosted(snapshot: EntitlementSnapshot | undefined) {
  return Boolean(snapshot && snapshot.caps.hosted && LIVE_PLAN_STATES.has(snapshot.state))
}

/**
 * The `hosted` provisioner's work for one change of an account's plan (§4.4's cloud computer row), idempotent:
 * - account deletion (`closing`): every session ended, every computer and disk deleted at the provider, the ledger's
 *   store state erased (its pseudonymous lines kept) and every hosted record of the account deleted (P5);
 * - active: nothing to stop; a deletion set earlier (a returning subscriber) is lifted;
 * - renewing: running sessions continue (the reaper starts no new block past the grace);
 * - paused: running sessions wrap up, snapshot and stop within five minutes;
 * - frozen: every session stopped now; the disks are kept with no deletion date until the dispute closes;
 * - ended, or a plan without a cloud computer: every session stopped; the disks are kept 14 days for download, paid
 *   from the final period (shorter when it cannot cover them), then deleted; after a lost dispute they are kept 30
 *   days at Vector's cost.
 */
export async function applyHostedTransition(t: Transition, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const { from, to } = t
  if (to.state === "ended" && to.reason === "closing") return eraseAccountHosted(t.account, options)
  const now = clock()
  if (liveHosted(to)) {
    await store(
      [
        "HSET",
        hostedRosterKey(),
        t.account,
        JSON.stringify({ plan: to.plan, state: to.state, periodStart: to.periodStart, periodEnd: to.periodEnd }),
      ],
      fetcher,
    )
    await store(["ZREM", hostedDiskDueKey(), t.account], fetcher)
  } else await store(["HDEL", hostedRosterKey(), t.account], fetcher)

  const access = hostedAccess(to, "on", now)
  const live = await liveSessions(t.account, fetcher)
  for (const record of live) {
    // Best effort: a stop the provider cannot make yet leaves the session stopping, and the reaper, which reads the
    // same snapshot every minute, finishes it. The disks below must not wait on it.
    if (access === "stop")
      await endHostedSession(record, to.state === "frozen" ? "frozen" : "plan", options).catch(() => undefined)
    else if (access === "wrap")
      await wrapHostedSession(record, now + Hosted.WRAP_MS, "plan", options).catch(() => undefined)
  }

  if (to.state === "frozen" || liveHosted(to)) return
  if (from && !liveHosted(from) && from.state !== "frozen") return
  // The plan no longer keeps the disks: set when they are deleted, once (the first date stands). §4.4 keeps an ended
  // plan's disks 14 days for download and WP A51 charges that to the final period (`chargeRetention`), but no route lets
  // an ended plan download its disk yet (a download-only start is not built), so nothing is charged for it: the disks
  // are kept the 14 days at Vector's cost, for a subscriber who comes back (P8 review; codium-deviations.md).
  const computers = await accountComputers(t.account, fetcher)
  if (!computers.length) return
  const until =
    now + (to.state === "ended" && to.reason === "disputed" ? Hosted.LOST_DISPUTE_DISK_DAYS : Hosted.ENDED_DISK_DAYS) * DAY
  await store(["ZADD", hostedDiskDueKey(), "NX", until, t.account], fetcher)
}

/** The account's sessions whose computer may be running. */
async function liveSessions(account: string, fetcher: typeof fetch) {
  const ids = await store(["ZREVRANGE", hostedSessionsKey(account), 0, 49], fetcher)
  const found: SessionRecord[] = []
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string") continue
    const record = await readSessionRecord(id, fetcher)
    if (record && record.account === account && Hosted.LIVE_STATES.includes(record.state)) found.push(record)
  }
  return found
}

async function accountComputers(account: string, fetcher: typeof fetch) {
  const members = await store(["SMEMBERS", hostedComputersKey(account)], fetcher)
  return (Array.isArray(members) ? members : [])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= 1)
    .sort((a, b) => a - b)
}

/**
 * Account deletion's part of the cloud computer (P5; the `hosted` provisioner on `closing`, and WP A57): every live
 * session ended, every computer and saved disk deleted at the provider, the ledger's store state erased (its lines,
 * pseudonymous, are kept), then every hosted record of the account. A step that fails throws, so the outbox retries and
 * nothing is left half-deleted silently.
 */
export async function eraseAccountHosted(account: string, options: SessionOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  for (const record of await liveSessions(account, fetcher)) {
    const ended = await endHostedSession(record, "closing", options)
    if (ended.state !== "ended") throw new ApiError(503, "HOSTED_UNAVAILABLE", "A cloud computer could not be stopped yet.")
  }
  const names = await eraseAccountComputers(account, {
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    fetcher,
    clock,
  })
  await eraseAccountHostedLedger(account, { fetcher, clock })
  const listed = await store(["ZRANGE", hostedSessionsKey(account), 0, -1], fetcher)
  const ids = (Array.isArray(listed) ? listed : []).filter((id): id is string => typeof id === "string")
  // The packed files in the media bucket, while the records still say which sessions had them (P8 review).
  await eraseSessionArchives(account, ids, options)
  const keys: string[] = []
  for (const id of ids)
    keys.push(hostedSessionKey(id), hostedJobKey(id), hostedBeatKey(id), hostedModelKey(id), hostedHostdKey(id), hostedHandoffAlertKey(id))
  for (let index = 0; index < keys.length; index += 240) await store(["DEL", ...keys.slice(index, index + 240)], fetcher)
  for (const computer of await accountComputers(account, fetcher)) {
    await store(["HDEL", hostedNamesKey(), computerName(account, computer)], fetcher)
    await store(["HDEL", hostedUsageKey(), computerName(account, computer)], fetcher)
  }
  await store(
    [
      "DEL",
      hostedSessionsKey(account),
      hostedLeaseKey(account),
      hostedComputersKey(account),
      hostedSuspendKey(account),
      hostedTrueUpKey(account),
      hostedArchivesKey(account),
    ],
    fetcher,
  )
  for (const key of [hostedSuspendedKey(), hostedRecentKey(), hostedDiskDueKey()])
    await store(["ZREM", key, account], fetcher)
  await store(["HDEL", hostedRosterKey(), account], fetcher)
  await store(["HDEL", hostedBudgetKey(), account], fetcher)
  return { computers: names.length, sessions: ids.length }
}

// ── Nightly ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Reading = { egressBytes: number; egressDay?: string; activeCpuMs?: number; durationMs?: number }

export type NightlyResult = {
  day: string
  deleted: number
  charged: number
  trued: number
  budgets: number
  skipped: number
  failed: number
}

/**
 * The nightly job (§4.19, 02:30 UTC), for the UTC day that just ended:
 * - deletions: accounts whose disks' retention ran out (ended plans, lost disputes) lose their computers and disks;
 * - charges: each computer's day of snapshot storage (at the worst-case disk size, while the plan is live) and its
 *   egress since the last reading (from the provider's cumulative figures), once per computer and day (WP A51's
 *   `chargeNightly`);
 * - true-up: the block charges of sessions that ended since the last pass, on computers running nothing now, are
 *   lowered towards the provider's actual cost plus 10% and never below it (WP A51's `trueUpCharge`, M8);
 * - the budget figures of every account whose plan includes a cloud computer (`hostedBudget`).
 */
export async function runHostedNightly(options: CronOptions = {}): Promise<NightlyResult> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const started = clock()
  const budget = options.budgetMs ?? 250_000
  const left = () => budget - (clock() - started)
  const day = utcDay(started - DAY)
  const result: NightlyResult = { day, deleted: 0, charged: 0, trued: 0, budgets: 0, skipped: 0, failed: 0 }
  const provider = options.provider === undefined ? hostedProvider() : options.provider

  // Deletions.
  const due = await store(["ZRANGEBYSCORE", hostedDiskDueKey(), "-inf", started, "LIMIT", 0, 200], fetcher)
  for (const account of Array.isArray(due) ? due : []) {
    if (typeof account !== "string" || left() <= 30_000) break
    try {
      const snapshot = await readSnapshot(account, fetcher)
      if (liveHosted(snapshot) || snapshot?.state === "frozen") {
        await store(["ZREM", hostedDiskDueKey(), account], fetcher)
        continue
      }
      if ((await liveSessions(account, fetcher)).length) {
        result.skipped++
        continue
      }
      await eraseAccountComputers(account, { ...(provider ? { provider } : {}), fetcher, clock })
      for (const computer of await accountComputers(account, fetcher)) {
        await store(["HDEL", hostedNamesKey(), computerName(account, computer)], fetcher)
        await store(["HDEL", hostedUsageKey(), computerName(account, computer)], fetcher)
      }
      await store(["DEL", hostedComputersKey(account)], fetcher)
      await store(["ZREM", hostedDiskDueKey(), account], fetcher)
      result.deleted++
    } catch {
      result.failed++
    }
  }

  // Charges and the true-up.
  if (provider?.configured()) {
    let computers: ComputerInfo[] = []
    try {
      computers = await provider.list(COMPUTER_PREFIX)
    } catch {
      result.failed++
    }
    const names = await hashEntries(hostedNamesKey(), fetcher)
    const readings = await hashEntries(hostedUsageKey(), fetcher)
    for (const computer of computers) {
      if (left() <= 30_000) break
      if (!isComputerName(computer.name)) continue
      const account = names.get(computer.name)
      if (!account) {
        result.skipped++
        continue
      }
      try {
        const reading = parseReading(readings.get(computer.name))
        const next = await chargeComputer(account, computer, reading, day, { fetcher, clock })
        if (next.charged) {
          result.charged++
          // Stored at once: should the true-up below fail, tomorrow's egress still starts from this reading, so the
          // bytes charged tonight are never charged again under tomorrow's line (P8 review).
          await store(["HSET", hostedUsageKey(), computer.name, JSON.stringify(next.reading)], fetcher)
        }
        const trued = await trueUpComputer(account, computer, next.reading, { fetcher, clock })
        result.trued += trued.lines
        await store(["HSET", hostedUsageKey(), computer.name, JSON.stringify(trued.reading)], fetcher)
      } catch {
        result.failed++
      }
    }
  }

  // Budget figures.
  const roster = await hashEntries(hostedRosterKey(), fetcher)
  for (const [account] of roster) {
    if (left() <= 5_000) break
    try {
      const snapshot = await readSnapshot(account, fetcher)
      if (!liveHosted(snapshot) || !snapshot!.plan) {
        await store(["HDEL", hostedRosterKey(), account], fetcher)
        continue
      }
      const capMinutes = planMinutes(snapshot!.plan)
      const { used } = await readHostedMinutes(snapshot!, fetcher, clock())
      await store(
        [
          "HSET",
          hostedBudgetKey(),
          account,
          JSON.stringify({
            plan: snapshot!.plan,
            periodEnd: snapshot!.periodEnd,
            minutesLeft: Math.max(0, capMinutes - used),
            at: clock(),
          }),
        ],
        fetcher,
      )
      result.budgets++
    } catch {
      result.failed++
    }
  }
  return result
}

async function hashEntries(key: string, fetcher: typeof fetch) {
  const flat = await store(["HGETALL", key], fetcher)
  const entries = new Map<string, string>()
  if (Array.isArray(flat)) for (let index = 0; index + 1 < flat.length; index += 2) entries.set(String(flat[index]), String(flat[index + 1]))
  return entries
}

function parseReading(raw: string | undefined): Reading | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Reading
    return Number.isFinite(value.egressBytes) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * One computer's nightly charge: a day of storage while the plan is live, and its egress since the last reading. A
 * listing with no egress figure (the provider's is optional) still charges the day's storage and keeps the last egress
 * reading, so the next figure charges everything since (P8 review).
 */
async function chargeComputer(
  account: string,
  computer: ComputerInfo,
  reading: Reading | undefined,
  day: string,
  options: { fetcher: typeof fetch; clock: () => number },
) {
  const egressNow = computer.egressBytes
  const before = reading?.egressBytes ?? 0
  if (reading?.egressDay === day) return { charged: false, reading }
  // A cumulative figure that went down means the computer was made again: everything it reports is new.
  const egressBytes = egressNow === undefined ? 0 : egressNow >= before ? egressNow - before : egressNow
  const snapshot = await readSnapshot(account, options.fetcher)
  const storageGbDays = liveHosted(snapshot) ? HOSTED_DISK_GB_MAX : 0
  if (storageGbDays > 0 || egressBytes > 0)
    await chargeNightly(
      account,
      { computer: computer.name, day, storageGbDays, egressGb: egressBytes / 1_000_000_000 },
      options,
    )
  return { charged: true, reading: { ...reading, egressBytes: egressNow ?? before, egressDay: day } }
}

/**
 * The true-up of one computer: when no session runs on it now, the block charges of the sessions that ended on it
 * since the last reading are lowered to their actual cost plus the markup. The actual cost of each block is its memory
 * for its billed minutes (never less than it ran) plus its share of the CPU time the provider reports for the computer
 * since the last reading, shared by billed minutes times vCPUs. CPU used outside those blocks is shared over them too,
 * which can only raise their cost, so a charge never falls below what it cost (M8). Sessions whose usage cannot be told
 * apart (a computer made again since the last reading) are left at their charge.
 */
async function trueUpComputer(
  account: string,
  computer: ComputerInfo,
  reading: Reading,
  options: { fetcher: typeof fetch; clock: () => number },
) {
  const fetcher = options.fetcher
  const number = Number(/-(\d)$/.exec(computer.name)?.[1])
  const nextReading: Reading = {
    ...reading,
    ...(computer.activeCpuMs !== undefined ? { activeCpuMs: computer.activeCpuMs } : {}),
    ...(computer.durationMs !== undefined ? { durationMs: computer.durationMs } : {}),
  }
  const leases = await readLeases(account, fetcher, options.clock())
  // A session running on the computer now would put part of its CPU in this reading: wait for a quiet night.
  if (leases.has(number) || computer.activeCpuMs === undefined) return { lines: 0, reading: reading }
  const pending = await store(["ZRANGE", hostedTrueUpKey(account), 0, -1], fetcher)
  const sessions: SessionRecord[] = []
  for (const id of Array.isArray(pending) ? pending : []) {
    if (typeof id !== "string") continue
    const record = await readSessionRecord(id, fetcher)
    if (record && record.computer === number) sessions.push(record)
  }
  if (!sessions.length) return { lines: 0, reading: nextReading }
  // No reading yet: the provider's figure covers the computer's whole life, which can only overstate these blocks'
  // cost, so the true-up stays at or above it.
  const cpuBefore = reading.activeCpuMs ?? 0
  const forget = async () => {
    for (const record of sessions) await store(["ZREM", hostedTrueUpKey(account), record.id], fetcher)
  }
  if (computer.activeCpuMs < cpuBefore) {
    await forget()
    return { lines: 0, reading: nextReading }
  }
  const cpuMs = computer.activeCpuMs - cpuBefore
  type Item = { ref: string; minutes: number; size: Hosted.Size }
  const items: Item[] = []
  for (const record of sessions)
    for (let block = 0; block <= record.block; block++)
      for (const ref of [`hb-${record.id}-${block}`, `hb-${record.id}-${block}-over`]) {
        const line = await readLine(account, ref, options)
        if (line && (line.kind === "block" || line.kind === "overrun") && line.units > 0)
          items.push({ ref, minutes: line.units, size: line.size ?? record.size })
      }
  const shares = items.reduce((sum, item) => sum + item.minutes * HOSTED_SIZES[item.size].vcpus, 0)
  let lines = 0
  for (const item of items) {
    const { memoryGb, vcpus } = HOSTED_SIZES[item.size]
    const memoryMicro = Math.ceil((item.minutes * MINUTE * memoryGb * MEMORY_GB_HOUR_MICRO) / HOUR)
    const cpuShare = shares > 0 ? (cpuMs * item.minutes * vcpus) / shares : 0
    // CPU time can never exceed the block's vCPUs for its minutes; anything past that stays counted (never lowered).
    const cpuMicro = Math.ceil((cpuShare * VCPU_HOUR_MICRO) / HOUR)
    const trued = await trueUpCharge(account, { ref: item.ref, actualCostMicro: memoryMicro + cpuMicro }, options)
    if (trued.lowered) lines++
  }
  await forget()
  return { lines, reading: nextReading }
}

// ── Drift ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type DriftResult = { checked: number; drifted: { account: string; expectedMinutes: number; chargedMinutes: number }[]; failed: number }

/**
 * The drift check (§4.19, every 10 minutes): for each account with session activity in the last day, the minutes its
 * sessions' lifecycles say its computers ran this period (start to stop, rounded up per block) against the minutes the
 * ledger charged, plus blocks still running or queued to settle. Less charged than ran by more than one minute per
 * block means a charge went missing (M8): the owner is emailed, naming accounts and minutes only.
 */
export async function checkHostedDrift(options: CronOptions = {}): Promise<DriftResult> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const started = clock()
  const budget = options.budgetMs ?? 45_000
  const result: DriftResult = { checked: 0, drifted: [], failed: 0 }
  const accounts = await store(["ZRANGEBYSCORE", hostedRecentKey(), started - DRIFT_WINDOW_MS, "+inf", "LIMIT", 0, 200], fetcher)
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (typeof account !== "string" || clock() - started >= budget) break
    try {
      const drift = await accountDrift(account, { fetcher, clock })
      if (!drift) continue
      result.checked++
      if (drift.expectedMinutes > drift.chargedMinutes + drift.tolerance)
        result.drifted.push({ account, expectedMinutes: drift.expectedMinutes, chargedMinutes: drift.chargedMinutes })
    } catch {
      result.failed++
    }
  }
  if (result.drifted.length)
    await notifyOwner(
      {
        kind: "hosted-drift",
        subject: "Vector cloud computers: charges are behind what computers ran",
        lines: [
          "These accounts' cloud computer sessions ran longer this period than the ledger charged (minutes, this period):",
          "",
          ...result.drifted.map((item) => `${item.account}: ran ${item.expectedMinutes}, charged ${item.chargedMinutes}`),
          "",
          "Check the settle queue (hosted:settle-due) and the reaper's runs. Nothing was changed automatically.",
        ],
        dedupeMs: 6 * HOUR,
      },
      fetcher,
    ).catch(() => undefined)
  return result
}

async function accountDrift(account: string, options: { fetcher: typeof fetch; clock: () => number }) {
  const { fetcher, clock } = options
  const snapshot = await readSnapshot(account, fetcher)
  if (!snapshot || snapshot.periodStart <= 0) return undefined
  const now = clock()
  const ids = await store(["ZRANGEBYSCORE", hostedSessionsKey(account), snapshot.periodStart - DAY, "+inf"], fetcher)
  let expectedMinutes = 0
  let blocks = 0
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string") continue
    const record = await readSessionRecord(id, fetcher)
    if (!record || record.startedAt === undefined) continue
    const start = Math.max(record.startedAt, snapshot.periodStart)
    const end = record.stoppedAt ?? (record.state === "ended" ? (record.endedAt ?? now) : now)
    if (end <= start) continue
    expectedMinutes += wholeMinutes(end - start)
    blocks += record.block + 1
  }
  if (!blocks) return undefined
  const charged = await periodCharges(account, snapshot.periodStart, options)
  const running = await runningBlocks(account, fetcher)
  const unsettled = running.reduce((sum, entry) => sum + wholeMinutes(now - entry.startedAt), 0)
  const queued = await store(["HGETALL", codiumKey("hosted", "settle", account)], fetcher)
  let queuedMinutes = 0
  if (Array.isArray(queued))
    for (let index = 1; index < queued.length; index += 2) {
      try {
        const entry = JSON.parse(String(queued[index])) as { startedAt: number; endedAt?: number }
        queuedMinutes += wholeMinutes((entry.endedAt ?? now) - entry.startedAt)
      } catch {}
    }
  return {
    expectedMinutes,
    chargedMinutes: charged.minutes + unsettled + queuedMinutes,
    tolerance: blocks + 1,
  }
}

// ── Budget ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A plan's full monthly cloud computer hours, in weighted minutes (no trust ramp: the worst case). */
function planMinutes(plan: PlanId) {
  return Math.floor((ENTITLEMENTS[plan].hosted?.hours ?? 0) * 60)
}

/**
 * The worst-case cost of the hosted team for the rest of the billing cycle (`GET /api/hosted/admin/budget`, read by the
 * budget workflow of WP A56, which sets max(current budget, spend + 1.3 × this)): for every account whose plan
 * includes a cloud computer, the hours left this period and the full hours of every period that starts before the
 * cycle ends (stepping by 28 days, the shortest month, so no period is missed), at the worst-case cost of a weighted
 * minute, plus each day's egress at the plan's fair-use cap and every computer the plan allows with its disk at the
 * worst-case size; and the disks Vector keeps for accounts whose plan no longer has a cloud computer (an ended plan's 14
 * days, a lost dispute's 30, a dispute still open), until the cycle ends. Owner-side only: never shown to a subscriber
 * (P1).
 */
export async function hostedBudget(input: { cycleEnd: number }, options: { fetcher?: typeof fetch; clock?: () => number } = {}) {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const now = clock()
  const roster = await hashEntries(hostedRosterKey(), fetcher)
  const cached = await hashEntries(hostedBudgetKey(), fetcher)
  const days = Math.max(0, Math.ceil((input.cycleEnd - now) / DAY))
  const egressCap = Math.max(...Object.values(HOSTED_ABUSE.egressGbPerDay))
  const counted = new Set<string>()
  let minutes = 0
  let computers = 0
  let egressGb = 0
  for (const [account, raw] of roster) {
    let entry: { plan?: unknown; periodEnd?: unknown }
    try {
      entry = JSON.parse(raw)
    } catch {
      continue
    }
    if (!isPlanId(entry.plan)) continue
    counted.add(account)
    const cap = planMinutes(entry.plan)
    const periodEnd = Number(entry.periodEnd)
    let left = cap
    try {
      const figures = JSON.parse(cached.get(account) ?? "null") as { periodEnd?: number; minutesLeft?: number } | null
      if (figures && figures.periodEnd === periodEnd && Number.isSafeInteger(figures.minutesLeft))
        left = Math.min(cap, Math.max(0, figures.minutesLeft!))
    } catch {}
    minutes += left
    // Every period that starts before the cycle ends brings the plan's full hours.
    for (let end = Number.isFinite(periodEnd) ? periodEnd : now; end < input.cycleEnd; end += 28 * DAY) minutes += cap
    computers += ENTITLEMENTS[entry.plan].hosted?.computers ?? 0
    const perDay = (HOSTED_ABUSE.egressGbPerDay as Partial<Record<PlanId, number>>)[entry.plan] ?? egressCap
    egressGb += perDay * days
  }
  // Disks kept for accounts off the roster: each computer Vector still knows the account had.
  const names = await hashEntries(hostedNamesKey(), fetcher)
  let retained = 0
  for (const account of names.values()) if (!counted.has(account)) retained++
  const storageMicro = Math.ceil((computers + retained) * HOSTED_DISK_GB_MAX * days * SNAPSHOT_GB_DAY_COST_MICRO)
  const computeMicro = minutes * weightedMinuteCostMicro()
  const egressMicro = Math.ceil(egressGb * egressGbCostMicro())
  return {
    computedAt: now,
    cycleEnd: input.cycleEnd,
    accounts: roster.size,
    minutes,
    computers,
    retained,
    egressGb,
    worstCaseUsd: Math.ceil((computeMicro + storageMicro + egressMicro) / 10_000) / 100,
  }
}
