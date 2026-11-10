import { Option, Schema } from "effect"
import {
  ENTITLEMENTS,
  PLAN_REASONS,
  PLAN_STATES,
  type EntitlementSnapshot,
  type Entitlements,
  type PlanReason,
  type PlanState,
} from "../../packages/schema/src/codium-entitlements.js"
import { PLANS, rank, type PlanId } from "../../packages/schema/src/codium-plan.js"
import { codiumKey } from "./codium-keys.js"
import { renewalGraceMinutes, TRUST_RAMP, trustRampDays } from "./codium-limits.js"
import { ApiError } from "./http.js"
import { requireCodiumLivemode, stripeMode } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The store side of the plan cache (contract §4.3): the snapshot's key, its decoder, the one script that writes it
 * together with its outbox items, the change listeners, and the meter script. Only reconcile
 * (`reconcileModelPlanAccount` in model-plan-account.ts) builds and writes a snapshot; every service reads it through
 * codium-entitlements.ts. This module never calls Stripe, so both of those can import it without importing each other.
 */

export type { EntitlementSnapshot, Entitlements, PlanReason, PlanState }

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** A snapshot older than this is rechecked on the next read. */
export const SNAPSHOT_STALE_MS = 6 * HOUR_MS
/** A `none` snapshot is cached this long, and a `renewing` one is rechecked at most this often. */
export const SNAPSHOT_RECHECK_MS = 60_000
/** Per-period meters outlive their period by this much, for the owner page and disputes. */
export const METER_KEEP_MS = 40 * DAY_MS

export const SNAPSHOT_SOURCES = ["webhook", "replay", "sweep", "request", "owner", "outbox"] as const
export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number]

export const snapshotKey = (account: string) => codiumKey("ent", account)
export const statusCacheKey = (account: string) => codiumKey("status", account)

const PLAN_IDS = PLANS.map((plan) => plan.id) as [PlanId, ...PlanId[]]
const Timestamp = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const Snapshot = Schema.Struct({
  v: Schema.Literal(1),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  livemode: Schema.Boolean,
  account: Schema.String,
  state: Schema.Literals(PLAN_STATES),
  reason: Schema.optional(Schema.Literals(PLAN_REASONS)),
  plan: Schema.NullOr(Schema.Literals(PLAN_IDS)),
  subscription: Schema.optional(Schema.String),
  periodStart: Timestamp,
  periodEnd: Timestamp,
  meterEpoch: Schema.String,
  cancelAtPeriodEnd: Schema.Boolean,
  scheduled: Schema.optional(Schema.Struct({ plan: Schema.Literals(PLAN_IDS), at: Timestamp })),
  founding: Schema.optional(Schema.Struct({ number: Schema.Number, boost: Schema.Boolean })),
  firstPaidAt: Schema.optional(Timestamp),
  firstHighPaidAt: Schema.optional(Timestamp),
  memberSince: Schema.optional(Timestamp),
  ramp: Schema.Struct({ hostedUntil: Timestamp, poolUntil: Schema.optional(Timestamp), browserFrom: Timestamp }),
  revokedBefore: Schema.optional(Timestamp),
  // Written only by this server from ENTITLEMENTS, so only its shape is checked here.
  caps: Schema.Record(Schema.String, Schema.Unknown),
  updatedAt: Timestamp,
  checkedAt: Timestamp,
  source: Schema.Literals(SNAPSHOT_SOURCES),
})

/** A stored snapshot, or undefined when it is missing, unreadable or for another account. Mode is not checked here. */
export function decodeSnapshot(raw: unknown, account: string): EntitlementSnapshot | undefined {
  if (typeof raw !== "string") return undefined
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Snapshot))(raw)
  if (Option.isNone(decoded) || decoded.value.account !== account) return undefined
  const caps = decoded.value.caps
  if (typeof caps.rank !== "number" || typeof caps.inFlight !== "number") return undefined
  return decoded.value as unknown as EntitlementSnapshot
}

/**
 * The account's snapshot as stored. A snapshot written in the other Stripe mode is refused (503), never served: keys
 * are already namespaced by mode, so one can only be there by mistake. An unreadable one reads as missing, and the
 * next reconcile rewrites it.
 */
export async function readSnapshot(account: string, fetcher: typeof fetch = fetch) {
  const snapshot = decodeSnapshot(await persistentStore(["GET", snapshotKey(account)], fetcher), account)
  if (snapshot) requireCodiumLivemode(snapshot)
  return snapshot
}

/**
 * What reconcile builds on: the stored snapshot when it is readable and in this server's mode, and the version any
 * readable one carries, so a rewrite always gets a higher version and the write script never refuses it.
 */
export async function readSnapshotForWrite(account: string, fetcher: typeof fetch = fetch) {
  const raw = await persistentStore(["GET", snapshotKey(account)], fetcher)
  const snapshot = decodeSnapshot(raw, account)
  const sameMode = snapshot && snapshot.livemode === (stripeMode() === "live") ? snapshot : undefined
  let version = snapshot?.version ?? 0
  if (!snapshot && typeof raw === "string") {
    const loose = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ version: Schema.Number })))(raw),
    )
    if (loose && Number.isSafeInteger(loose.version)) version = loose.version
  }
  return { previous: sameMode, version }
}

/** Fresh enough to serve without a Stripe call (contract §4.3 read rules). */
export function isStale(snapshot: EntitlementSnapshot, now = Date.now()) {
  const age = now - snapshot.checkedAt
  // No plan: cached for a minute. Renewing: Stripe's answer can change any moment, so a minute at most.
  if (snapshot.state === "none" || snapshot.state === "renewing") return age >= SNAPSHOT_RECHECK_MS
  if (age > SNAPSHOT_STALE_MS) return true
  // Paused, ended and frozen snapshots written by reconcile are trusted until the next notification or the age limit;
  // an active one is rechecked once its period is over.
  return snapshot.state === "active" && now >= snapshot.periodEnd
}

const PAYMENT_MESSAGES = {
  payment_failed: "Your last Vector Codium payment did not go through. Update your card to keep using Vector Codium.",
  action_required: "Your bank needs you to confirm your Vector Codium payment.",
  payment_pending: "Your Vector Codium renewal has not been paid yet. Update your card to keep using Vector Codium.",
} as const
const ACTIONS = {
  payment_failed: "update-card",
  action_required: "confirm-payment",
  payment_pending: "update-card",
} as const

/** Why a paused plan is paused and what fixes it: the same answer the 402 and the status's `plan.action` give. */
export function pausedPayment(snapshot: Pick<EntitlementSnapshot, "reason">) {
  const reason =
    snapshot.reason === "action_required" || snapshot.reason === "payment_pending" ? snapshot.reason : "payment_failed"
  return { reason, action: ACTIONS[reason] } as const
}

/**
 * The snapshot when its plan state lets it use Codium now, or `requireEntitlement`'s refusal for that state. Here so a
 * snapshot already in hand (one a reconcile just returned, or the one a pool hold reads) gets the same final answers
 * without codium-entitlements.ts and model-plan-account.ts importing each other:
 * - 402 `MODEL_PLAN_REQUIRED` without a plan, or once it ended (409 `MODEL_PLAN_ACCOUNT_CLOSING` while the account is
 *   being deleted);
 * - 402 `MODEL_PLAN_PAYMENT_REQUIRED {reason, action}` while a payment is owed;
 * - 403 `MODEL_PLAN_BLOCKED {reason}` while a dispute, a fraud warning or the owner holds it;
 * - 503 `MODEL_PLAN_RENEWING` (retry after 30 s) once a renewal's grace ran out before reconcile caught up.
 */
export function requireUsableSnapshot(snapshot: EntitlementSnapshot | undefined, now = Date.now()) {
  if (!snapshot || snapshot.state === "none")
    throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Vector Codium plan to use this.")
  if (snapshot.state === "ended") {
    if (snapshot.reason === "closing")
      throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Vector Codium is closed.")
    throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Your Vector Codium plan has ended. Choose a plan to use this.", {
      detail: snapshot.reason ? { reason: snapshot.reason } : undefined,
    })
  }
  if (snapshot.state === "paused") {
    const payment = pausedPayment(snapshot)
    throw new ApiError(402, "MODEL_PLAN_PAYMENT_REQUIRED", PAYMENT_MESSAGES[payment.reason], { detail: payment })
  }
  if (snapshot.state === "frozen")
    throw new ApiError(
      403,
      "MODEL_PLAN_BLOCKED",
      snapshot.reason === "disputed"
        ? "Vector Codium is on hold for this account while a payment dispute is open."
        : "Vector Codium is on hold for this account. Contact Vector support.",
      { detail: { reason: snapshot.reason ?? "owner" } },
    )
  if (snapshot.state === "renewing" && now >= snapshot.periodEnd + renewalGraceMinutes() * 60_000)
    throw new ApiError(503, "MODEL_PLAN_RENEWING", "Your Vector Codium plan is renewing. Try again in a moment.", {
      retryAfterSeconds: 30,
    })
  return snapshot
}

/** A per-period counter's key, `meter:<account>:<meterEpoch>:<name>` under the mode prefix: new with every period. */
export function meterKey(snapshot: Pick<EntitlementSnapshot, "account" | "meterEpoch">, name: string) {
  return codiumKey("meter", snapshot.account, snapshot.meterEpoch, name)
}

// ── Building a snapshot ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The caps of an account without a plan: nothing at all. `rank` must be one of the plan ranks for the type's sake;
 * every reader checks `state` first, and every count here is 0.
 */
export const NO_CAPS: Entitlements = Object.freeze<Entitlements>({
  rank: 1,
  usageMultiple: 0,
  inFlight: 0,
  perMinute: 0,
  dailyShare: 0,
  contextMax: 0,
  priority: false,
  fastLanes: false,
  previewModels: false,
  purposeShare: { brain: 0 },
  cloudAgents: { atOnce: 0, hours: 0, longestRunMin: 0, scheduledPerDay: 0, runCeilingShare: 0 },
  remote: { computers: 0 },
  vault: { gb: 0, versionDays: 0 },
  hosted: null,
  overnight: null,
  ops: null,
  secondOpinion: false,
  playbooks: false,
  vote: false,
  nominate: false,
  reports: { tag: "plus", perHour: 0, readFirst: false },
  foundingBoost: null,
  velocity: null,
  labs: null,
})

/**
 * A plan's caps with the trust ramp applied (§4.2): until `hostedUntil`, cloud computers run at a quarter of the hours,
 * one at a time, with jobs of two hours at most. A plain copy, so it can be stored and changed.
 */
export function effectiveCaps(plan: PlanId | null, ramp: EntitlementSnapshot["ramp"], now: number): Entitlements {
  const caps = structuredClone(plan ? ENTITLEMENTS[plan] : NO_CAPS) as {
    -readonly [K in keyof Entitlements]: Entitlements[K]
  }
  if (caps.hosted && now < ramp.hostedUntil)
    caps.hosted = {
      ...caps.hosted,
      hours: caps.hosted.hours * TRUST_RAMP.hostedHoursFactor,
      computers: Math.min(caps.hosted.computers, TRUST_RAMP.computers),
      jobMin: Math.min(caps.hosted.jobMin, TRUST_RAMP.jobMinutes),
    }
  return caps
}

/** What reconcile learned from Stripe and the account record, before versioning. Times are milliseconds. */
export type SnapshotFacts = {
  account: string
  state: PlanState
  reason?: PlanReason
  plan: PlanId | null
  subscription?: string
  periodStart: number
  periodEnd: number
  cancelAtPeriodEnd: boolean
  scheduled?: { plan: PlanId; at: number }
  firstPaidAt?: number
  firstHighPaidAt?: number
  memberSince?: number
  source: SnapshotSource
  poolUntil?: number
  poolDailyShare?: number
}

/**
 * The snapshot for `facts`. Its version goes up only when something a service acts on changed; a recheck that finds
 * nothing new keeps the version and `updatedAt` and moves only `checkedAt`, so side effects deduplicated by version
 * (contract §4.5) run once per change, however many notifications report it.
 */
export function buildSnapshot(
  facts: SnapshotFacts,
  previous: EntitlementSnapshot | undefined,
  now: number,
  baseVersion = previous?.version ?? 0,
): EntitlementSnapshot {
  const high = facts.firstHighPaidAt
  const ramp = {
    hostedUntil: high === undefined ? 0 : high + trustRampDays() * DAY_MS,
    browserFrom: high === undefined ? 0 : high + TRUST_RAMP.browserAfterMs,
    ...(facts.poolUntil === undefined ? {} : { poolUntil: facts.poolUntil }),
  }
  // Run tokens and relay sessions issued before a freeze stop working (the github-runs and remote provisioners).
  const revokedBefore = facts.state === "frozen" && previous?.state !== "frozen" ? now : previous?.revokedBefore
  const candidate: EntitlementSnapshot = {
    v: 1,
    version: baseVersion + 1,
    livemode: stripeMode() === "live",
    account: facts.account,
    state: facts.state,
    ...(facts.reason ? { reason: facts.reason } : {}),
    plan: facts.plan,
    ...(facts.subscription ? { subscription: facts.subscription } : {}),
    periodStart: facts.periodStart,
    periodEnd: facts.periodEnd,
    meterEpoch: facts.subscription ? `${facts.subscription}:${facts.periodStart}` : "none",
    cancelAtPeriodEnd: facts.cancelAtPeriodEnd,
    ...(facts.scheduled ? { scheduled: facts.scheduled } : {}),
    ...(facts.firstPaidAt === undefined ? {} : { firstPaidAt: facts.firstPaidAt }),
    ...(high === undefined ? {} : { firstHighPaidAt: high }),
    ...(facts.memberSince === undefined ? {} : { memberSince: facts.memberSince }),
    ramp,
    ...(revokedBefore === undefined ? {} : { revokedBefore }),
    caps: {
      ...effectiveCaps(facts.plan, ramp, now),
      ...(facts.poolDailyShare === undefined ? {} : { dailyShare: facts.poolDailyShare }),
    },
    updatedAt: now,
    checkedAt: now,
    source: facts.source,
  }
  if (previous && material(previous) === material(candidate) && previous.version >= baseVersion)
    return { ...candidate, version: previous.version, updatedAt: previous.updatedAt }
  return candidate
}

/** Everything a service acts on, in one canonical spelling: the snapshot without its bookkeeping. */
function material(snapshot: EntitlementSnapshot) {
  const { version: _version, updatedAt: _updated, checkedAt: _checked, source: _source, ...rest } = snapshot
  return canonical(rest)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

// ── Changes and the outbox ──────────────────────────────────────────────────────────────────────────────────────

/** Why a snapshot changed, for provisioners and owner alerts (contract §4.8). */
export type TransitionCause =
  | "first_payment"
  | "renewal"
  | "upgrade"
  | "downgrade"
  | "payment_failed"
  | "payment_recovered"
  | "cancel_scheduled"
  | "ended"
  | "refunded"
  | "disputed"
  | "dispute_won"
  | "early_fraud_warning"
  | "closing"
  | "owner"

/** One change of an account's snapshot: §4.8's `Transition`. */
export type EntitlementChange = {
  account: string
  from?: EntitlementSnapshot
  to: EntitlementSnapshot
  cause: TransitionCause
}

/** An outbox item a listener asks to be written in the same step as the snapshot. `priority` items drain first. */
export type OutboxItem = { id: string; at?: number; priority?: boolean; payload: unknown }

/**
 * The outbox is one sorted set scored by when an item is due (ms). The priority lane (freezes and revocations, WP A06)
 * sits this far below it, at negative scores, so it always sorts first and keeps its own due times for retries.
 */
export const PRIORITY_LEAD_MS = 10_000_000_000_000
/** An outbox item's score: due at `at`, in the priority lane or not (the drain lives in codium-provision.ts). */
export function outboxScore(at: number, priority = false) {
  return priority ? at - PRIORITY_LEAD_MS : at
}

/**
 * Told of every change before it is written, a listener answers the outbox items that change needs; they are written in
 * the same script as the snapshot, so a crash can never leave a new snapshot without its work queued. The outbox
 * (codium-provision.ts) registers here and answers one item per configured provisioner.
 */
export type EntitlementListener = (change: EntitlementChange) => readonly OutboxItem[] | void

const listeners: EntitlementListener[] = []

/** Registers a listener for snapshot changes. Returns a function that removes it again. */
export function onEntitlementChange(listener: EntitlementListener) {
  listeners.push(listener)
  return () => {
    const index = listeners.indexOf(listener)
    if (index >= 0) listeners.splice(index, 1)
  }
}

/** The best name for what moved an account from `from` to `to`. A change with no better name is a renewal. */
export function transitionCause(from: EntitlementSnapshot | undefined, to: EntitlementSnapshot): TransitionCause {
  if (to.reason === "closing") return "closing"
  if (to.state === "frozen")
    return to.reason === "disputed" ? "disputed" : to.reason === "early_fraud_warning" ? "early_fraud_warning" : "owner"
  if (to.state === "ended" || to.state === "none") {
    if (to.reason === "refunded" || to.reason === "disputed" || to.reason === "early_fraud_warning") return to.reason
    if (to.reason === "payment_failed") return "payment_failed"
    return "ended"
  }
  if (to.state === "paused") return "payment_failed"
  if (!from || from.state === "none" || from.state === "ended") return "first_payment"
  if (from.state === "frozen") return from.reason === "disputed" ? "dispute_won" : "owner"
  if (from.state === "paused") return "payment_recovered"
  if (to.state === "renewing") return "renewal"
  if (from.plan && to.plan && from.plan !== to.plan) return rank(to.plan) > rank(from.plan) ? "upgrade" : "downgrade"
  if (from.meterEpoch !== to.meterEpoch) return "renewal"
  if (from.cancelAtPeriodEnd !== to.cancelAtPeriodEnd) return "cancel_scheduled"
  return "renewal"
}

/**
 * WRITE. Sets the snapshot (KEYS[1], ARGV[1]; kept ARGV[7] ms when that is not empty) unless a higher version is
 * stored, clears the status cache (KEYS[2]), files the account in the period-end index for the sweeps (KEYS[3]: added
 * at ARGV[4] when ARGV[3] is 1, else removed; member ARGV[5]), sets `sales-opened-at` (KEYS[4]) to ARGV[6] if it is not
 * set yet and ARGV[6] is not empty, and writes each outbox item (KEYS[6..], with id, score and payload in ARGV from 8
 * on, three each) into the outbox (KEYS[5]). All of it in one step. Returns 1, or 0 when a newer snapshot was there.
 */
const WRITE = [
  "local current = redis.call('GET', KEYS[1])",
  "if current then local ok, old = pcall(cjson.decode, current)",
  "if ok and type(old) == 'table' and tonumber(old['version']) and tonumber(old['version']) > tonumber(ARGV[2]) then return 0 end end",
  "if ARGV[7] ~= '' then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[7]) else redis.call('SET', KEYS[1], ARGV[1]) end",
  "redis.call('DEL', KEYS[2])",
  "if ARGV[3] == '1' then redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5]) else redis.call('ZREM', KEYS[3], ARGV[5]) end",
  "if ARGV[6] ~= '' then redis.call('SET', KEYS[4], ARGV[6], 'NX') end",
  "for i = 6, #KEYS do local at = 8 + (i - 6) * 3",
  "redis.call('SET', KEYS[i], ARGV[at + 2]) redis.call('ZADD', KEYS[5], ARGV[at + 1], ARGV[at]) end",
  "return 1",
].join(" ")

/**
 * METER_ADD. Adds ARGV[1] to the meter (KEYS[1]) only while the total stays within ARGV[2], and keeps it until ARGV[3]
 * (ms). Returns {1, total} when added, {0, total} when it would pass the cap.
 */
const METER_ADD = [
  "local used = tonumber(redis.call('GET', KEYS[1]) or '0') or 0",
  "if used + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return {0, used} end",
  "used = redis.call('INCRBY', KEYS[1], ARGV[1])",
  "redis.call('PEXPIREAT', KEYS[1], ARGV[3])",
  "return {1, used}",
].join(" ")

/** The scripts, for the tests and any store fake that has to recognise them. */
export const SNAPSHOT_SCRIPTS = Object.freeze({ WRITE, METER_ADD })

/** States the period-end index keeps, so the sweeps find accounts whose period is over or whose payment is stuck. */
const INDEXED: ReadonlySet<PlanState> = new Set(["active", "renewing", "paused", "frozen"])
/**
 * A `none` snapshot lapses after a week, so accounts that never bought anything do not keep a record forever; the next
 * read after that rechecks them, as it would a minute after the last check anyway.
 */
export const NONE_SNAPSHOT_KEEP_MS = 7 * DAY_MS

/**
 * Writes `snapshot`, with the outbox items its listeners ask for when its version is new, the status cache cleared
 * and, on a paid snapshot, `sales-opened-at` set once, in one EVAL. Returns whether it was written and the change it
 * recorded, if any.
 */
export async function writeSnapshot(
  snapshot: EntitlementSnapshot,
  previous: EntitlementSnapshot | undefined,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const changed = !previous || previous.version !== snapshot.version
  const change: EntitlementChange | undefined = changed
    ? { account: snapshot.account, from: previous, to: snapshot, cause: transitionCause(previous, snapshot) }
    : undefined
  const items = change ? listeners.flatMap((listener) => [...(listener(change) ?? [])]) : []
  const written = await persistentStore(
    [
      "EVAL",
      WRITE,
      5 + items.length,
      snapshotKey(snapshot.account),
      statusCacheKey(snapshot.account),
      codiumKey("idx", "period-end"),
      codiumKey("sales-opened-at"),
      codiumKey("outbox"),
      ...items.map((item) => codiumKey("outbox", "item", item.id)),
      JSON.stringify(snapshot),
      snapshot.version,
      INDEXED.has(snapshot.state) ? "1" : "0",
      snapshot.periodEnd,
      snapshot.account,
      snapshot.state === "active" ? now : "",
      snapshot.state === "none" ? NONE_SNAPSHOT_KEEP_MS : "",
      ...items.flatMap((item) => [
        item.id,
        outboxScore(item.at ?? now, item.priority === true),
        JSON.stringify(item.payload ?? null),
      ]),
    ],
    fetcher,
  )
  return { written: Number(written) === 1, change }
}

/** Runs the meter script: see `meterAdd` in codium-entitlements.ts. */
export async function runMeterAdd(key: string, amount: number, cap: number, expireAt: number, fetcher: typeof fetch) {
  const result = await persistentStore(["EVAL", METER_ADD, 1, key, amount, cap, expireAt], fetcher)
  const [ok, used] = Array.isArray(result) ? result.map(Number) : []
  if ((ok !== 0 && ok !== 1) || !Number.isSafeInteger(used)) return undefined
  return { ok: ok === 1, used: used! }
}
