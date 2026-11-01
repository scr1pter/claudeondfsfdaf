import { randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { codiumKey } from "./codium-keys.js"
import { notifyOwner, ownerAlertsConfigured } from "./codium-owner.js"
import {
  decodeSnapshot,
  onEntitlementChange,
  outboxScore,
  PRIORITY_LEAD_MS,
  readSnapshot,
  transitionCause,
  type EntitlementChange,
  type OutboxItem,
  type TransitionCause,
} from "./codium-snapshot.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The outbox (contract §4.8). Reconcile writes an account's snapshot and, in the same EVAL, one outbox item for every
 * configured provisioner, so a crash can never leave a new snapshot without the work it needs queued. Other durable work
 * (a reconcile a webhook could not finish, a renewal to finalize, a superseded subscription to cancel, …) is queued
 * with `enqueueAction`. The minute cron drains both under one global lock within a time budget: revocations and
 * freezes first, then everything due, each item retried with backoff, and after ten failures set aside as a dead letter
 * the owner is told about. Provisioners record the last snapshot version they applied (`prov:<provisioner>:<account>`),
 * so an older change never undoes a newer one, and the daily sweep re-queues any that fell behind.
 *
 * Provisioners are listed in codium-provisioners.ts; action handlers register next to what they run (model-plan-account
 * registers `reconcile` and `debit-apply`; later work packages add theirs).
 */

export type { TransitionCause }
/** One change of an account's snapshot, as provisioners see it (§4.8's `Transition`). */
export type Transition = EntitlementChange

/** A service that follows the plan cache. `apply` is idempotent and converges the service to `t.to`. */
export interface PerkProvisioner {
  readonly id: string
  /** Whether the service exists on this deployment. Only configured provisioners get outbox items. */
  configured(): boolean
  apply(t: Transition, fetcher?: typeof fetch): Promise<void>
}

export const ACTION_KINDS = [
  "reconcile",
  "supersede",
  "carry-trueup",
  "purchase-confirmation",
  "finalize-renewal",
  "pool-ramp",
  "pause-collection",
  "debit-apply",
  "model-settle",
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]
/** The outbox's own action: an owner alert that is retried until it is sent (dead letters use it). */
const OWNER_ALERT = "owner-alert"
type AnyActionKind = ActionKind | typeof OWNER_ALERT

/** An action as its handler sees it. `attempts` counts the earlier failed tries; `now` is the drain's clock. */
export type OutboxAction = { kind: string; key: string; payload: unknown; attempts: number; now: number }
export type ActionHandler = (action: OutboxAction, fetcher: typeof fetch) => Promise<void>

/** Actions that stop money or access drain in the priority lane, ahead of everything else that is due. */
const PRIORITY_ACTIONS: ReadonlySet<string> = new Set<AnyActionKind>(["reconcile", "pause-collection"])

const TRANSITION_CAUSES = [
  "first_payment",
  "renewal",
  "upgrade",
  "downgrade",
  "payment_failed",
  "payment_recovered",
  "cancel_scheduled",
  "ended",
  "refunded",
  "disputed",
  "dispute_won",
  "early_fraud_warning",
  "closing",
  "owner",
] as const satisfies readonly TransitionCause[]
// Every cause the snapshot module can report is one this module decodes.
const allCauses: Exclude<TransitionCause, (typeof TRANSITION_CAUSES)[number]> extends never ? true : false = true
void allCauses

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** Tries before an item becomes a dead letter. */
export const OUTBOX_MAX_ATTEMPTS = 10
/** A dead letter stays readable this long, for the owner page; the daily sweep re-queues provisioners meanwhile. */
export const OUTBOX_DEAD_KEEP_MS = 30 * DAY_MS
export const OUTBOX_DRAIN_BUDGET_MS = 50_000
// The lock outlives the budget by this much, so the last item started within the budget can finish under it.
const LOCK_SLACK_MS = 30_000
const LOCK_MIN_REMAINING_MS = 5_000
const DRAIN_BATCH = 25
const DRAIN_MAX_ITEMS = 500
const MAX_RECORD_CHARS = 64_000
const PROVISIONER_ID = /^[a-z][a-z0-9-]{0,31}$/
const ACTION_KEY = /^[A-Za-z0-9_.:-]{1,200}$/

/** Wait before the next try after `attempts` failures: 30 s, doubling, at most an hour (about 3.7 h for all ten). */
export function outboxBackoffMs(attempts: number) {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), HOUR_MS)
}

const outboxKey = () => codiumKey("outbox")
const itemKey = (id: string) => codiumKey("outbox", "item", id)
const deadKey = () => codiumKey("outbox", "dead")
const lockKey = () => codiumKey("outbox", "lock")
/** The last snapshot version a provisioner applied for an account. */
export const provKey = (provisioner: string, account: string) => codiumKey("prov", provisioner, account)
/** A provisioner's item for one snapshot version: one per version, so every change is applied in its turn. */
export const provisionItemId = (provisioner: string, account: string, version: number) =>
  `${provisioner}:${account}:${version}`
export const actionItemId = (kind: string, key: string) => `${kind}:${key}`

// ── Scripts ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ENQUEUE. Writes item KEYS[2] (ARGV[2]) into the outbox KEYS[1] as ARGV[1], due at score ARGV[3], keeping an earlier
 * due time it already had, and takes it off the dead letters KEYS[3]. With ARGV[4] = 'keep', an item that is already
 * waiting is left as it is (the sweep's re-queue). Returns 1 when written, 0 when kept.
 */
const ENQUEUE = [
  "local pending = redis.call('ZSCORE', KEYS[1], ARGV[1])",
  "if pending and ARGV[4] == 'keep' then return 0 end",
  "redis.call('SET', KEYS[2], ARGV[2])",
  "if (not pending) or tonumber(ARGV[3]) < tonumber(pending) then redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1]) end",
  "redis.call('ZREM', KEYS[3], ARGV[1])",
  "return 1",
].join(" ")

/**
 * FINISH. Removes item ARGV[1] (KEYS[2]) from the outbox KEYS[1] when it still holds what the drain read (ARGV[2]); one
 * queued again meanwhile stays. With KEYS[3], raises that provisioner's applied version to ARGV[3], never lowers it.
 */
const FINISH = [
  "if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('DEL', KEYS[2]) redis.call('ZREM', KEYS[1], ARGV[1]) end",
  "if KEYS[3] then local current = tonumber(redis.call('GET', KEYS[3]) or '0') or 0",
  "if tonumber(ARGV[3]) > current then redis.call('SET', KEYS[3], ARGV[3]) end end",
  "return 1",
].join(" ")

/**
 * RETRY. When item KEYS[2] still holds ARGV[2]: with ARGV[5] = '0', rewrites it as ARGV[3] due at score ARGV[4]
 * (returns 1); with '1', moves ARGV[1] from the outbox KEYS[1] to the dead letters KEYS[3] at ARGV[4], keeps the record
 * ARGV[6] ms, drops dead letters scored before ARGV[7], and, with KEYS[4], queues the owner alert ARGV[8] (record
 * ARGV[9], score ARGV[10]) unless it is already waiting (returns 2). Returns 0 when the item changed meanwhile.
 */
const RETRY = [
  "if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end",
  "if ARGV[5] ~= '1' then redis.call('SET', KEYS[2], ARGV[3]) redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1]) return 1 end",
  "redis.call('ZREM', KEYS[1], ARGV[1])",
  "redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[6])",
  "redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[7])",
  "redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])",
  "if KEYS[4] and not redis.call('ZSCORE', KEYS[1], ARGV[8]) then",
  "redis.call('SET', KEYS[4], ARGV[9]) redis.call('ZADD', KEYS[1], ARGV[10], ARGV[8]) end",
  "return 2",
].join(" ")

/** RAISE. Sets KEYS[1] to ARGV[1], kept ARGV[2] ms, only when that is higher than what it holds. Returns 1 if raised. */
const RAISE = [
  "local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0",
  "if tonumber(ARGV[1]) > current then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end",
  "return 0",
].join(" ")

// The global drain lock is a lease like the billing lease (billing-lock.ts), with the same two scripts, word for word.
const LOCK_CHECK = "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end; return redis.call('PTTL', KEYS[1])"
const LOCK_RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0"

/** The outbox's scripts, for the tests and any store fake that has to recognise them. */
export const OUTBOX_SCRIPTS = Object.freeze({ ENQUEUE, FINISH, RETRY, RAISE, LOCK_CHECK, LOCK_RELEASE })

// ── Records ────────────────────────────────────────────────────────────────────────────────────────────────────────

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ProvisionRecord = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("provision"),
  provisioner: Schema.String,
  account: Schema.String,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cause: Schema.Literals(TRANSITION_CAUSES),
  priority: Schema.Boolean,
  from: Schema.optional(Schema.Unknown),
  to: Schema.Unknown,
  attempts: Count,
  createdAt: Schema.Number,
  error: Schema.optional(Schema.String),
})
const ActionRecord = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("action"),
  kind: Schema.String,
  key: Schema.String,
  priority: Schema.Boolean,
  payload: Schema.optional(Schema.Unknown),
  attempts: Count,
  createdAt: Schema.Number,
  error: Schema.optional(Schema.String),
})
type ProvisionRecord = typeof ProvisionRecord.Type
type ActionRecord = typeof ActionRecord.Type
type OutboxRecord = ProvisionRecord | ActionRecord

function decodeRecord(raw: string): OutboxRecord | undefined {
  return (
    Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(ProvisionRecord))(raw)) ??
    Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(ActionRecord))(raw))
  )
}

const OwnerAlertPayload = Schema.Struct({
  kind: Schema.String,
  subject: Schema.String,
  lines: Schema.Array(Schema.String),
})

// ── Registries ─────────────────────────────────────────────────────────────────────────────────────────────────────

const provisioners = new Map<string, PerkProvisioner>()
/** Independent action registries keep scoped drains isolated without replacing production handlers. */
export function createActionRegistry() {
  const handlers = new Map<string, ActionHandler>()
  return {
    get: (kind: string) => handlers.get(kind),
    register(kind: ActionKind, handler: ActionHandler) {
      if (!(ACTION_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown outbox action ${kind}.`)
      if (handlers.has(kind)) throw new Error(`The outbox action ${kind} already has a handler.`)
      handlers.set(kind, handler)
      return () => {
        if (handlers.get(kind) === handler) handlers.delete(kind)
      }
    },
  }
}
export type ActionRegistry = ReturnType<typeof createActionRegistry>
const actions = createActionRegistry()

/** Adds a provisioner (the static list is codium-provisioners.ts). Returns a function that removes it again. */
export function registerProvisioner(provisioner: PerkProvisioner) {
  if (!PROVISIONER_ID.test(provisioner.id)) throw new Error(`Provisioner id ${provisioner.id} is not valid.`)
  if (provisioners.has(provisioner.id)) throw new Error(`A provisioner named ${provisioner.id} is already registered.`)
  provisioners.set(provisioner.id, provisioner)
  return () => {
    if (provisioners.get(provisioner.id) === provisioner) provisioners.delete(provisioner.id)
  }
}

/** The handler that runs one kind of action. Returns a function that removes it again. */
export function registerAction(kind: ActionKind, handler: ActionHandler) {
  return actions.register(kind, handler)
}

function isConfigured(provisioner: PerkProvisioner) {
  try {
    return provisioner.configured() === true
  } catch {
    return false
  }
}

/** The ids of the provisioners that get outbox items on this deployment, in registration order. */
export function configuredProvisioners() {
  return [...provisioners.values()].filter(isConfigured).map((provisioner) => provisioner.id)
}

// ── Snapshot changes → provisioner items ──────────────────────────────────────────────────────────────────────────

/**
 * Whether a change takes access away, so its work goes in the priority lane: a freeze, an ending, or a new
 * `revokedBefore` (run tokens and relay sessions issued earlier stop working).
 */
export function revokes(change: Transition) {
  const { from, to } = change
  if (to.revokedBefore !== undefined && to.revokedBefore !== from?.revokedBefore) return true
  return (to.state === "frozen" || to.state === "ended") && (from?.state !== to.state || from?.reason !== to.reason)
}

/**
 * A change no provisioner has anything to do for: an account that has not had a plan, before or now (every account
 * that only ever reads status gets such a snapshot). No item is written for it, and the sweep does not re-queue it.
 */
function nothingToProvision(change: Transition) {
  return change.to.state === "none" && (!change.from || change.from.state === "none")
}

function provisionItem(provisioner: string, change: Transition, at: number): OutboxItem {
  const priority = revokes(change)
  const record: ProvisionRecord = {
    v: 1,
    type: "provision",
    provisioner,
    account: change.account,
    version: change.to.version,
    cause: change.cause,
    priority,
    ...(change.from ? { from: change.from } : {}),
    to: change.to,
    attempts: 0,
    createdAt: at,
  }
  return { id: provisionItemId(provisioner, change.account, change.to.version), at, priority, payload: record }
}

// Registered once, when this module loads: every snapshot write that brings a new version queues one item per
// configured provisioner in the same EVAL (codium-snapshot.ts `writeSnapshot`).
onEntitlementChange((change) =>
  nothingToProvision(change)
    ? []
    : configuredProvisioners().map((provisioner) => provisionItem(provisioner, change, change.to.updatedAt)),
)

/**
 * The daily sweep's repair: for each configured provisioner whose applied version is behind the account's snapshot,
 * queues an item for the current snapshot, unless one is already waiting. This catches work that never ran: an item
 * lost with the store, a provisioner configured after the change, a dead letter. Returns how many it queued.
 */
export async function requeueBehindProvisioners(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const snapshot = await readSnapshot(account, fetcher)
  if (!snapshot) return 0
  let requeued = 0
  for (const provisioner of configuredProvisioners()) {
    const applied = await appliedVersion(provisioner, account, fetcher)
    if (applied >= snapshot.version) continue
    // A provisioner that never applied anything for an account that has no plan has nothing to catch up on.
    if (applied === 0 && snapshot.state === "none") continue
    const item = provisionItem(provisioner, { account, to: snapshot, cause: transitionCause(undefined, snapshot) }, now)
    const written = await persistentStore(
      [
        "EVAL",
        ENQUEUE,
        3,
        outboxKey(),
        itemKey(item.id),
        deadKey(),
        item.id,
        JSON.stringify(item.payload),
        outboxScore(now, item.priority),
        "keep",
      ],
      fetcher,
    )
    if (Number(written) === 1) requeued++
  }
  return requeued
}

async function appliedVersion(provisioner: string, account: string, fetcher: typeof fetch) {
  const stored = await persistentStore(["GET", provKey(provisioner, account)], fetcher)
  if (stored === null || stored === undefined) return 0
  const version = Number(stored)
  if (!Number.isSafeInteger(version) || version < 0) throw unavailable()
  return version
}

// ── Actions ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Owner holds and their repair action become durable together, including a unique publication token. */
export const ACCOUNT_RECONCILE_SCRIPT = `redis.call('SET', KEYS[4], ARGV[5]) ${ENQUEUE}`
export async function saveAccountAndReconcile(
  account: string,
  record: unknown,
  fetcher: typeof fetch,
  now = Date.now(),
) {
  const id = actionItemId("reconcile", account)
  const action: ActionRecord = {
    v: 1,
    type: "action",
    kind: "reconcile",
    key: account,
    priority: true,
    payload: { ownerIntent: randomUUID() },
    attempts: 0,
    createdAt: now,
  }
  await persistentStore(
    [
      "EVAL",
      ACCOUNT_RECONCILE_SCRIPT,
      4,
      outboxKey(),
      itemKey(id),
      deadKey(),
      codiumKey("account", account),
      id,
      JSON.stringify(action),
      outboxScore(now, true),
      "replace",
      JSON.stringify(record),
    ],
    fetcher,
  )
}

/**
 * Queues durable work, due at `at` (now by default). One item per kind and key: queuing it again replaces its payload,
 * keeps the earlier due time and starts its tries over, and takes it off the dead letters. Resolves once the item is
 * stored, so a caller that answers "accepted" (the webhook) can rely on it running.
 */
export async function enqueueAction(
  kind: ActionKind,
  key: string,
  payload: unknown,
  at?: number,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!(ACTION_KINDS as readonly string[]).includes(kind)) throw invalid()
  await enqueueRecord(kind, key, payload, at ?? now, fetcher, now)
}

async function enqueueRecord(
  kind: AnyActionKind,
  key: string,
  payload: unknown,
  at: number,
  fetcher: typeof fetch,
  now: number,
) {
  if (!ACTION_KEY.test(key) || !Number.isSafeInteger(at) || at < 0) throw invalid()
  const priority = PRIORITY_ACTIONS.has(kind)
  const record: ActionRecord = {
    v: 1,
    type: "action",
    kind,
    key,
    priority,
    ...(payload === undefined ? {} : { payload }),
    attempts: 0,
    createdAt: now,
  }
  const raw = JSON.stringify(record)
  if (raw.length > MAX_RECORD_CHARS) throw invalid()
  const id = actionItemId(kind, key)
  await persistentStore(
    ["EVAL", ENQUEUE, 3, outboxKey(), itemKey(id), deadKey(), id, raw, outboxScore(at, priority), "replace"],
    fetcher,
  )
}

// The outbox's own action: an owner alert retried until it is sent. Unreadable or unconfigured alerts are dropped.
async function runOwnerAlert(action: OutboxAction, fetcher: typeof fetch) {
  const alert = Option.getOrUndefined(Schema.decodeUnknownOption(OwnerAlertPayload)(action.payload))
  if (!alert) return
  if ((await notifyOwner(alert, fetcher)) === "failed")
    throw new ApiError(503, "CODIUM_OWNER_ALERT_FAILED", "The owner alert could not be sent.")
}

// ── The drain ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type DrainResult = {
  /** Items whose work ran and succeeded. */
  applied: number
  /** Items that failed and wait for their next try. */
  retried: number
  /** Items set aside after their last try. */
  dead: number
  /** Items with nothing left to do: superseded by a newer version, unconfigured, or gone. */
  skipped: number
  /** Another drain held the lock; this one did nothing. */
  busy: boolean
}

/**
 * Runs what is due, within `budgetMs`, under the global lock `outbox:lock` (SET NX, so two crons never drain at once):
 * the priority lane first (freezes and revocations), then everything else in due order. Each item that fails is tried
 * again after `outboxBackoffMs`; after the tenth failure it becomes a dead letter and the owner is alerted. A minute
 * with nothing due costs one store read and takes no lock.
 */
export async function drainOutbox(
  options: {
    budgetMs?: number
    now?: number
    fetcher?: typeof fetch
    limit?: number
    actionRegistry?: ActionRegistry
  } = {},
): Promise<DrainResult> {
  const fetcher = options.fetcher ?? fetch
  const budget = options.budgetMs ?? OUTBOX_DRAIN_BUDGET_MS
  const started = Date.now()
  // The clock due times are read against: real time, or a fixed `now` (tests and replays move it themselves).
  const clock = () => options.now ?? Date.now()
  const result: DrainResult = { applied: 0, retried: 0, dead: 0, skipped: 0, busy: false }
  const peek = await persistentStore(["ZRANGEBYSCORE", outboxKey(), "-inf", clock(), "LIMIT", 0, 1], fetcher)
  if (!Array.isArray(peek) || peek.length === 0) return result
  const token = randomUUID()
  const taken = await persistentStore(["SET", lockKey(), token, "NX", "PX", budget + LOCK_SLACK_MS], fetcher)
  if (taken !== "OK") return { ...result, busy: true }
  try {
    const limit = options.limit ?? DRAIN_MAX_ITEMS
    let handled = 0
    while (handled < limit && Date.now() - started < budget) {
      const due = await dueItems(clock(), Math.min(DRAIN_BATCH, limit - handled), fetcher)
      if (!due.length) break
      for (const id of due) {
        if (handled >= limit || Date.now() - started >= budget) break
        // Stop if the lock lapsed or was taken over: another drain may be running these items now.
        const remaining = await persistentStore(["EVAL", LOCK_CHECK, 1, lockKey(), token], fetcher)
        if (typeof remaining !== "number" || remaining < LOCK_MIN_REMAINING_MS) return result
        handled++
        result[await runItem(id, clock(), fetcher, options.actionRegistry ?? actions)]++
      }
    }
    return result
  } finally {
    await persistentStore(["EVAL", LOCK_RELEASE, 1, lockKey(), token], fetcher).catch(() => undefined)
  }
}

/** Up to `count` due item ids: the priority lane's first, then the rest, each in due order. */
async function dueItems(now: number, count: number, fetcher: typeof fetch): Promise<string[]> {
  const range = async (min: number | string, max: number, size: number) => {
    const found = await persistentStore(["ZRANGEBYSCORE", outboxKey(), min, max, "LIMIT", 0, size], fetcher)
    if (!Array.isArray(found)) throw unavailable()
    return found.map(String)
  }
  const priority = await range("-inf", now - PRIORITY_LEAD_MS, count)
  if (priority.length >= count) return priority
  return [...priority, ...(await range(0, now, count - priority.length))]
}

type Outcome = Exclude<keyof DrainResult, "busy">

async function runItem(id: string, now: number, fetcher: typeof fetch, registry: ActionRegistry): Promise<Outcome> {
  const raw = await persistentStore(["GET", itemKey(id)], fetcher)
  if (typeof raw !== "string") {
    // The record is gone (cleared by hand, or lost with the store): nothing is left to run.
    await persistentStore(["ZREM", outboxKey(), id], fetcher)
    return "skipped"
  }
  const record = decodeRecord(raw)
  if (!record) return fail(id, raw, undefined, new Error("The outbox item could not be read."), now, fetcher, true)
  if (record.type === "provision") return runProvision(id, raw, record, now, fetcher)
  const handler = record.kind === OWNER_ALERT ? runOwnerAlert : registry.get(record.kind)
  try {
    if (!handler) throw new ApiError(503, "CODIUM_OUTBOX_NO_HANDLER", `No handler runs ${record.kind} here.`)
    await handler(
      { kind: record.kind, key: record.key, payload: record.payload, attempts: record.attempts, now },
      fetcher,
    )
  } catch (error) {
    return fail(id, raw, record, error, now, fetcher)
  }
  await finish(id, raw, undefined, fetcher)
  return "applied"
}

async function runProvision(id: string, raw: string, record: ProvisionRecord, now: number, fetcher: typeof fetch) {
  const to = decodeSnapshot(JSON.stringify(record.to), record.account)
  const from = record.from === undefined ? undefined : decodeSnapshot(JSON.stringify(record.from), record.account)
  if (!to || to.version !== record.version || (record.from !== undefined && !from))
    return fail(id, raw, record, new Error("The outbox item's snapshot could not be read."), now, fetcher, true)
  const provisioner = provisioners.get(record.provisioner)
  // A provisioner removed or switched off since the change has nothing to converge here.
  if (!provisioner || !isConfigured(provisioner)) {
    await finish(id, raw, undefined, fetcher)
    return "skipped"
  }
  // An older change never undoes a newer one already applied.
  if ((await appliedVersion(record.provisioner, record.account, fetcher)) >= record.version) {
    await finish(id, raw, undefined, fetcher)
    return "skipped"
  }
  try {
    await provisioner.apply({ account: record.account, ...(from ? { from } : {}), to, cause: record.cause }, fetcher)
  } catch (error) {
    return fail(id, raw, record, error, now, fetcher)
  }
  await finish(id, raw, { provisioner: record.provisioner, account: record.account, version: record.version }, fetcher)
  return "applied"
}

async function finish(
  id: string,
  raw: string,
  applied: { provisioner: string; account: string; version: number } | undefined,
  fetcher: typeof fetch,
) {
  await persistentStore(
    applied
      ? [
          "EVAL",
          FINISH,
          3,
          outboxKey(),
          itemKey(id),
          provKey(applied.provisioner, applied.account),
          id,
          raw,
          applied.version,
        ]
      : ["EVAL", FINISH, 2, outboxKey(), itemKey(id), id, raw, 0],
    fetcher,
  )
}

/**
 * Records a failed try: the item waits `outboxBackoffMs` for its next one, in its own lane, or after the last try (or
 * at once, when it cannot be read) becomes a dead letter, with an owner alert queued in the same step.
 */
async function fail(
  id: string,
  raw: string,
  record: OutboxRecord | undefined,
  error: unknown,
  now: number,
  fetcher: typeof fetch,
  unreadable = false,
): Promise<Outcome> {
  const attempts = (record?.attempts ?? 0) + 1
  const dead = unreadable || attempts >= OUTBOX_MAX_ATTEMPTS
  const reason = describe(error)
  const next = record ? JSON.stringify({ ...record, attempts, error: reason }) : raw
  if (!dead) {
    const score = outboxScore(now + outboxBackoffMs(attempts), record?.priority === true)
    const moved = await persistentStore(
      ["EVAL", RETRY, 3, outboxKey(), itemKey(id), deadKey(), id, raw, next, score, "0"],
      fetcher,
    )
    return Number(moved) === 1 ? "retried" : "skipped"
  }
  // An owner alert that cannot be sent is not alerted about again.
  const alert =
    record?.type === "action" && record.kind === OWNER_ALERT ? undefined : deadLetterAlert(id, attempts, reason, now)
  const moved = await persistentStore(
    [
      "EVAL",
      RETRY,
      alert ? 4 : 3,
      outboxKey(),
      itemKey(id),
      deadKey(),
      ...(alert ? [itemKey(alert.id)] : []),
      id,
      raw,
      next,
      now,
      "1",
      OUTBOX_DEAD_KEEP_MS,
      now - OUTBOX_DEAD_KEEP_MS,
      ...(alert ? [alert.id, alert.raw, outboxScore(now, false)] : []),
    ],
    fetcher,
  )
  return Number(moved) === 2 ? "dead" : "skipped"
}

/** The owner alert for a dead letter, as an outbox item of its own, or undefined when alerts are not configured. */
function deadLetterAlert(id: string, attempts: number, reason: string, now: number) {
  if (!ownerAlertsConfigured()) return undefined
  const key = `outbox-dead:${id}`
  if (!ACTION_KEY.test(key)) return undefined
  const record: ActionRecord = {
    v: 1,
    type: "action",
    kind: OWNER_ALERT,
    key,
    priority: false,
    payload: {
      kind: key,
      subject: "Vector Codium: an outbox job was set aside",
      lines: [
        `The outbox job ${id} failed ${attempts} times and was set aside as a dead letter.`,
        `Last error: ${reason}`,
        "",
        "Accounts are named by id only. The job stays in the dead letters for 30 days. The daily sweep queues a provisioner again while it is behind its snapshot; other jobs run again when they are queued again.",
      ],
    },
    attempts: 0,
    createdAt: now,
  }
  return { id: actionItemId(OWNER_ALERT, key), raw: JSON.stringify(record) }
}

/** What went wrong, for the dead letters and the owner: an error code or name and its message, never a value. */
function describe(error: unknown) {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`.slice(0, 300)
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300)
  return "Unknown error"
}

function invalid() {
  return new ApiError(500, "CODIUM_OUTBOX_INVALID", "This Vector Codium job could not be queued.")
}

function unavailable() {
  return new ApiError(503, "CODIUM_OUTBOX_UNAVAILABLE", "The Vector Codium outbox could not be read.")
}
