import { closeCloudWorkspaces, cloudWorkspacesConfigured } from "./cloud-workspaces.js"
import { codiumKeyIn, codiumKeyMode, codiumKeyPrefix, codiumKeyRoot } from "./codium-keys.js"
import { eraseCloudAgentsAccount } from "./cloud-agents-runs.js"
import { eraseFounding } from "./codium-founding.js"
import { notifyOwner } from "./codium-owner.js"
import { forgetAccountOutbox } from "./codium-provision.js"
import {
  readTombstone,
  releaseDeletionLease,
  saveTombstone,
  scheduleTombstone,
  takeDeletionLease,
  TOMBSTONE_KEEP_MS,
  unscheduleTombstone,
  dueTombstones,
  type DeletionStage,
  type Tombstone,
} from "./codium-tombstone.js"
import { eraseAccountHosted } from "./hosted-crons.js"
import { eraseAccountHostedJobs } from "./hosted-jobs.js"
import { EVERYWHERE_ERASE_PART } from "./everywhere/erase.js"
import { ApiError } from "./http.js"
import { cancelModelPlanAccount, reconcileModelPlanAccount } from "./model-plan-account.js"
import { stripeMode, type StripeMode } from "./model-plan-stripe.js"
import { eraseAccountOps } from "./ops-cleanup.js"
import { persistentStore } from "./persistent-store.js"
import { relayConfigured, relayErase } from "./remote-relay.js"
import { revocationConfigured, revokeAccountTokens } from "./revocation.js"
import { eraseAccountBallots } from "./roadmap.js"
import { eraseAccountReports } from "./support-reports.js"
import { forgetUsage } from "./usage.js"
import { eraseAccountVault, vaultStoreConfigured } from "./vault-store.js"
import { eraseAccountPushSubscriptions } from "./web-push.js"

/*
 * Account deletion's Codium half (contract WP A57, P5). `api/account/delete.ts` sets the tombstone
 * (codium-tombstone.ts) and then runs `finishAccountDeletion`, in this order:
 *   1. revoke the account's CLI and desktop tokens, first, so they stop working even if the next step cannot run yet;
 *      right after that attempt, whatever it answered, close the account's cloud workspaces on their host, best effort,
 *      so their engines stop even while a step below keeps failing (the `workspaces` erase part records the outcome);
 *   2. close: reconcile under the tombstone, so the account's snapshot is `ended`/`closing` and every service that reads
 *      it refuses new work (this is how the start and enqueue paths see the tombstone; see codium-tombstone.ts);
 *   3. cancel billing (`cancelModelPlanAccount`: checkouts expired, subscriptions cancelled, Codium keys disabled);
 *   4. erase, part by part (`eraseParts()`: `ERASE_PARTS` and any part another package registered), first the cloud
 *      workspaces' part (which takes the close from step 1 instead of asking the host again), and only when every
 *      service part is erased, the account's own Codium records and then every other store key that still names the
 *      account (`eraseAccountKeys`); then the erase marker (`erasedAt`) is written;
 *   5. erase the usage counts (as before A57; a failure there is reported, not retried);
 *   6. delete the Vector identity, which waits for the erase marker.
 * Anything that fails leaves the tombstone and files the deletion as due again with a backoff; the cleanup cron
 * (`/api/account/deletions`) continues from where it stopped and alerts the owner after `DELETION_ALERT_AFTER` tries.
 * After the identity is gone, one follow-up pass `DELETION_RECHECK_MS` later erases everything again, catching anything a
 * request that was already past its checks created in the meantime, and then the deletion is finished. That pass also
 * waits for the workspace host to report every workspace of the account erased: the host erases them in the background
 * after the close, so until it has, the pass fails, the deletion stays due and the owner is alerted like any other.
 *
 * Kept on purpose (P5's "pseudonymous financial ledger lines"): the hosted ledger's lines (named by an HMAC of the
 * account), the pool debits (`debits:<account>:<keyHash>`) and the spend counters keyed by the pool's hash (`held:`,
 * `day:`, `purpose:`, `model-spend:`, `model-reservations:`), which all expire with their period (A30's privacy draft
 * lists their retention); the run-token revocation mark (a security record that expires); the disabled OpenRouter keys
 * and Stripe's own records. Per-period counters keyed by the account id itself (`meter:`, `estimate:`, the cloud
 * computer's fair-use counts) are not ledger lines and are erased. The tombstone itself is kept `TOMBSTONE_KEEP_MS`
 * after the deletion finished.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** A deletion run holds its lease this long: longer than the request's own time limit. */
export const DELETION_LEASE_MS = 2 * MINUTE_MS
/** After the identity is gone, the follow-up pass runs this much later: longer than any request already under way. */
export const DELETION_RECHECK_MS = 15 * MINUTE_MS
/** The owner is emailed once a deletion has failed this many times. */
export const DELETION_ALERT_AFTER = 6
const RETRY_FIRST_MS = 10 * MINUTE_MS
const RETRY_MAX_MS = 6 * HOUR_MS

/** How long the cleanup cron waits before the `attempts`-th retry: 10 minutes, doubling, at most 6 hours. */
export function deletionRetryMs(attempts: number) {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1))
}

/**
 * What every part gets: the fetcher, the deletion's clock, the real time (ms) by which a long part must stop, which pass
 * this is (`erase` before the identity goes, `check` for the follow-up pass after it), and whether this run already
 * closed the account's cloud workspaces (finishAccountDeletion does that right after revoking tokens; the `workspaces`
 * part then settles with that outcome instead of asking the host a second time).
 */
export type EraseContext = {
  readonly fetcher: typeof fetch
  readonly now: number
  readonly deadline?: number
  readonly pass?: "erase" | "check"
  readonly workspacesClosed?: boolean
}

/**
 * One part of an account's records. `configured` says whether this deployment can reach it at all (a service that was
 * never set up holds nothing); `requires` names parts that must be erased first, because this one deletes what they
 * find their records by.
 */
export type ErasePart = {
  readonly id: string
  readonly configured: () => boolean
  readonly requires?: readonly string[]
  readonly erase: (account: string, context: EraseContext) => Promise<unknown>
}

function storeConfigured() {
  const url = process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim()
  const token = process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  return Boolean(url && token)
}

/**
 * Whether the cloud computer's records can exist here: every computer name, recording path and ledger line is derived
 * from VECTOR_HOSTED_ACCOUNT_SALT (hosted-ledger.ts `hostedAccount`), so without it nothing hosted was ever made and its
 * erase functions cannot run.
 */
function hostedErasable() {
  return storeConfigured() && (process.env.VECTOR_HOSTED_ACCOUNT_SALT?.trim() ?? "").length >= 32
}

/**
 * The modes whose Codium records an account can have: a live server also erases what it wrote under `test` before a
 * live Stripe key was set; a test server never touches live records.
 */
export function eraseModes(mode: StripeMode = stripeMode()): StripeMode[] {
  return mode === "live" ? ["live", "test"] : ["test"]
}

/**
 * The account's own Codium records, last: its billing record (customer, keys, risk), snapshot, status cache, reconcile
 * mark, place in the period-end index, collection pauses and in-flight set in every mode it may have written, then its
 * waiting outbox items and the provisioners' applied versions. The services erased before it read the closing snapshot
 * and the record, so it runs only after all of them succeeded.
 */
export async function eraseCodiumRecords(account: string, context: EraseContext) {
  for (const mode of eraseModes()) {
    await persistentStore(
      [
        "DEL",
        ...["account", "ent", "status", "reconcile", "collection", "inflight"].map((kind) =>
          codiumKeyIn(mode, kind, account),
        ),
      ],
      context.fetcher,
    )
    await persistentStore(["ZREM", codiumKeyIn(mode, "idx", "period-end"), account], context.fetcher)
  }
  await forgetAccountOutbox(account, context.fetcher)
}

/**
 * Whether a store key that names the account is one deletion keeps on purpose (P5), judged on the key after its
 * `<codium prefix><mode>:` part:
 * - `tombstone:<account>` and its `:lease`: the deletion's own record and the lease of the run doing it;
 * - `lease:<account>`: the billing lease a reconcile may hold this second (it lapses within a minute);
 * - `debits:<account>:<keyHash>`: pool debits, the store's pseudonymous ledger lines, which expire with their period;
 * - `runs:revoked-before:<account>`: keeps run tokens issued before a freeze refused, until it expires (35 days).
 */
export function keptAccountKey(rest: string, account: string) {
  return (
    rest === `tombstone:${account}` ||
    rest === `tombstone:${account}:lease` ||
    rest === `lease:${account}` ||
    rest.startsWith(`debits:${account}:`) ||
    rest === `runs:revoked-before:${account}`
  )
}

/** A glob that matches the value literally, for SCAN's MATCH. */
function globLiteral(value: string) {
  return value.replace(/[*?[\]\\]/g, (char) => `\\${char}`)
}

/** A regular expression source that matches the value literally. */
function regexLiteral(value: string) {
  return value.replace(/[.*+?^$|{}()[\]\\]/g, "\\$&")
}

/**
 * The last part: every key still left in the modes `eraseModes` names whose name carries the account id (as a whole
 * word: after `:` or `-`, before `:` or the end), except those `keptAccountKey` keeps. It catches the families no part
 * erases by name: per-period meters (`meter:<account>:…`), cached estimates (`estimate:<account>:…`), the cloud
 * computer's hourly and daily fair-use counts, Done by Morning's nightly counts, the no-run spend counter, the status
 * cache, and anything a later package adds keyed by the account. One SCAN pass over the store (the hosted ledger's
 * erase scans the same way); it stops with an error at the deadline, so the cron runs it again. Shared sets and hashes
 * that hold the account as a member are the other parts' work: this deletes whole keys only.
 */
export async function eraseAccountKeys(account: string, context: EraseContext) {
  const modes = eraseModes()
  const named = new RegExp(`(?:^|[:-])${regexLiteral(account)}(?::|$)`)
  const scope = modes.length === 1 ? codiumKeyPrefix(modes[0]!) : codiumKeyRoot()
  let cursor = "0"
  let erased = 0
  do {
    if (context.deadline !== undefined && Date.now() >= context.deadline)
      throw new ApiError(503, "ACCOUNT_ERASE_PENDING", "The store scan did not finish in time.")
    const page = await persistentStore(
      ["SCAN", cursor, "MATCH", `${scope}*${globLiteral(account)}*`, "COUNT", 1000],
      context.fetcher,
    )
    if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1]))
      throw new ApiError(503, "PERSISTENT_STORE_UNAVAILABLE", "Protected account services are temporarily unavailable.")
    cursor = String(page[0])
    const keys = page[1].filter((key): key is string => {
      if (typeof key !== "string") return false
      const mode = codiumKeyMode(key)
      if (!mode || !modes.includes(mode)) return false
      const rest = key.slice(codiumKeyPrefix(mode).length)
      return named.test(rest) && !keptAccountKey(rest, account)
    })
    for (let index = 0; index < keys.length; index += 200) {
      await persistentStore(["DEL", ...keys.slice(index, index + 200)], context.fetcher)
      erased += Math.min(200, keys.length - index)
    }
  } while (cursor !== "0")
  return erased
}

/** The `workspaces` part: the close this run already made, or a new one; the follow-up pass also needs them erased. */
function eraseCloudWorkspaces(account: string, context: EraseContext) {
  if (context.workspacesClosed === true) return Promise.resolve()
  if (context.workspacesClosed === false)
    return Promise.reject(new ApiError(503, "WORKSPACE_SERVICE_UNAVAILABLE", "The workspace host did not close."))
  return closeCloudWorkspaces(account, context.fetcher, {
    ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
    ...(context.pass === "check" ? { requireErased: true } : {}),
  })
}

/**
 * Every part. First the cloud workspaces' account fence (`closeCloudWorkspaces`: the host refuses the account from
 * then on and erases its workspaces itself; finishAccountDeletion already closed it right after revoking tokens, and
 * the follow-up pass fails this part until the host reports none left); then, in the contract's order: the report index, ballots and nominations, the founders listing, push
 * subscriptions, relay devices, the vault (its wrapped key first, its objects later by the vault cleanup), Done by
 * Morning's queue and recordings (before the cloud computer, whose session list it reads), computers and their saved
 * disks with the sessions and the ledger's store state, the ops records (monitors, domains, incidents, cards and their
 * images) with the ops Worker's data, GitHub bindings and run records, Everywhere's installations and jobs, the
 * account's own Codium records, and last every other Codium key that names the account. The last two wait for every
 * other part, because they delete the indexes those parts find their records by. Feature switches never skip erasure.
 */
export const ERASE_PARTS: readonly ErasePart[] = [
  { id: "workspaces", configured: () => cloudWorkspacesConfigured(), erase: eraseCloudWorkspaces },
  { id: "reports", configured: storeConfigured, erase: (account, c) => eraseAccountReports(account, c.fetcher) },
  { id: "roadmap", configured: storeConfigured, erase: (account, c) => eraseAccountBallots(account, c.fetcher, c.now) },
  { id: "founding", configured: storeConfigured, erase: (account, c) => eraseFounding(account, c.fetcher) },
  { id: "push", configured: storeConfigured, erase: (account, c) => eraseAccountPushSubscriptions(account, c.fetcher) },
  { id: "remote", configured: relayConfigured, erase: (account, c) => relayErase(account, c.fetcher, c.now) },
  {
    id: "vault",
    configured: vaultStoreConfigured,
    erase: (account, c) => eraseAccountVault(account, { fetcher: c.fetcher, now: c.now }),
  },
  {
    id: "overnight",
    configured: hostedErasable,
    erase: (account, c) => eraseAccountHostedJobs(account, { fetcher: c.fetcher, clock: () => c.now }),
  },
  {
    id: "computer",
    configured: hostedErasable,
    requires: ["overnight"],
    erase: (account, c) => eraseAccountHosted(account, { fetcher: c.fetcher, clock: () => c.now }),
  },
  { id: "ops", configured: storeConfigured, erase: (account, c) => eraseAccountOps(account, c.fetcher, c.now) },
  {
    id: "cloud-agents",
    configured: storeConfigured,
    erase: (account, c) =>
      eraseCloudAgentsAccount(account, async (command) => {
        if (c.deadline !== undefined && Date.now() >= c.deadline)
          throw new ApiError(503, "ACCOUNT_ERASE_PENDING", "The run-record cleanup did not finish in time.")
        return persistentStore(command, c.fetcher)
      }),
  },
  EVERYWHERE_ERASE_PART,
  {
    id: "codium",
    configured: storeConfigured,
    requires: [
      "workspaces",
      "reports",
      "roadmap",
      "founding",
      "push",
      "remote",
      "vault",
      "overnight",
      "computer",
      "ops",
      "cloud-agents",
      "everywhere",
    ],
    erase: eraseCodiumRecords,
  },
  { id: "keys", configured: storeConfigured, requires: ["codium"], erase: eraseAccountKeys },
]

const registeredParts: ErasePart[] = []
const PART_ID = /^[a-z][a-z-]{0,31}$/

/**
 * Adds a part another package owns, for records this module cannot reach by itself. The integrated GitHub and
 * Everywhere services already have permanent entries in ERASE_PARTS; later packages can extend that list here. A registered
 * part runs after the built-in service parts and before the account's own records, which wait for it, so a failure
 * keeps the identity and the cron retries it. Its id is what the tombstone and the owner's alert show. Returns a
 * function that removes it (for tests).
 */
export function registerErasePart(part: ErasePart) {
  if (!PART_ID.test(part.id) || [...ERASE_PARTS, ...registeredParts].some((known) => known.id === part.id))
    throw new Error(`An erase part needs a new id of lower-case letters and dashes: ${part.id}`)
  registeredParts.push(part)
  return () => {
    const index = registeredParts.indexOf(part)
    if (index >= 0) registeredParts.splice(index, 1)
  }
}

/** Every part in the order a deletion runs them: `ERASE_PARTS`, with registered parts before the account's own records. */
export function eraseParts(): readonly ErasePart[] {
  if (!registeredParts.length) return ERASE_PARTS
  const at = ERASE_PARTS.findIndex((part) => part.id === "codium")
  const extra = registeredParts.map((part) => part.id)
  return [
    ...ERASE_PARTS.slice(0, at),
    ...registeredParts,
    ...ERASE_PARTS.slice(at).map((part) =>
      part.id === "codium" ? { ...part, requires: [...(part.requires ?? []), ...extra] } : part,
    ),
  ]
}

export type EraseResult = { erased: boolean; failed: string[]; skipped: string[] }

/**
 * Runs every configured part. A part that fails does not stop the others, except those that require it; a part not
 * started by `deadline` counts as failed, so the cron finishes it. Erased only when every configured part succeeded.
 */
export async function eraseAccountData(
  account: string,
  options: {
    fetcher?: typeof fetch
    now?: number
    deadline?: number
    parts?: readonly ErasePart[]
    pass?: EraseContext["pass"]
    workspacesClosed?: boolean
  } = {},
): Promise<EraseResult> {
  const context: EraseContext = {
    fetcher: options.fetcher ?? fetch,
    now: options.now ?? Date.now(),
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ...(options.pass === undefined ? {} : { pass: options.pass }),
    ...(options.workspacesClosed === undefined ? {} : { workspacesClosed: options.workspacesClosed }),
  }
  const failed: string[] = []
  const skipped: string[] = []
  for (const part of options.parts ?? eraseParts()) {
    if (!part.configured()) {
      skipped.push(part.id)
      continue
    }
    if ((part.requires ?? []).some((id) => failed.includes(id))) {
      failed.push(part.id)
      continue
    }
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      failed.push(part.id)
      continue
    }
    try {
      await part.erase(account, context)
    } catch {
      // Only the part's id is kept: errors can carry addresses or account details.
      failed.push(part.id)
    }
  }
  return { erased: failed.length === 0, failed, skipped }
}

// ── The identity ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The Supabase admin settings identity deletion needs, or undefined when this deployment cannot delete identities. */
export function identityAdmin() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? ""
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""
  return url && serviceRole ? { url, serviceRole } : undefined
}

/** Deletes the Vector identity. An identity that is already gone counts as deleted. */
export async function deleteAccountIdentity(
  admin: { url: string; serviceRole: string },
  id: string,
  fetcher: typeof fetch = fetch,
) {
  const result = await fetcher(`${admin.url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: {
      apikey: admin.serviceRole,
      authorization: `Bearer ${admin.serviceRole}`,
    },
  })
  if (!result.ok && result.status !== 404) {
    throw new ApiError(
      502,
      "DELETION_FAILED",
      "Your records are erased, but Vector could not delete the account itself yet. Vector keeps trying, or you can retry account deletion.",
    )
  }
}

// ── Running a deletion ─────────────────────────────────────────────────────────────────────────────────────────────

export type DeletionOptions = {
  fetcher?: typeof fetch
  clock?: () => number
  /** Parts not started by then (real time, ms) are left for the cleanup cron. */
  deadline?: number
  parts?: readonly ErasePart[]
  /** Each step, replaceable by tests. */
  close?: (account: string) => Promise<unknown>
  revoke?: (account: string) => Promise<boolean>
  closeWorkspaces?: (account: string) => Promise<unknown>
  cancel?: (account: string) => Promise<unknown>
  forget?: (account: string) => Promise<boolean>
  identity?: (account: string) => Promise<void>
}

export type DeletionOutcome =
  | { state: "deleted"; tokens: "revoked" | "expire-within-90-days"; usage: "deleted" | "deletion-failed" }
  | { state: "pending"; stage: DeletionStage; failed: string[] }
  | { state: "busy" }
  | { state: "checked" }

/**
 * Runs (or continues) the deletion of an account whose tombstone is set. Steps already done are not repeated: once
 * the erase marker is written, only the identity is left. Returns `deleted` once the identity is gone, `pending` with
 * the stage that stopped it (the deletion is filed as due again), or `busy` while another run holds the lease. Without a
 * store there is no tombstone and no Codium record to erase; the steps that apply still run in order.
 */
export async function finishAccountDeletion(account: string, options: DeletionOptions = {}): Promise<DeletionOutcome> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const store = storeConfigured()
  let record: Tombstone | undefined
  let token: string | undefined
  if (store) {
    record = await readTombstone(account, fetcher)
    if (!record) throw new ApiError(409, "ACCOUNT_DELETION_NOT_STARTED", "Account deletion has not started.")
    if (record.identityAt !== undefined) return { state: "deleted", tokens: "revoked", usage: "deleted" }
    token = await takeDeletionLease(account, DELETION_LEASE_MS, fetcher)
    if (!token) return { state: "busy" }
  }
  const pending = async (stage: DeletionStage, failed: string[] = []): Promise<DeletionOutcome> => {
    if (record) record = await recordFailure(account, record, stage, failed, fetcher, clock())
    return { state: "pending", stage, failed }
  }
  try {
    let tokens: "revoked" | "expire-within-90-days" = "revoked"
    if (record?.erasedAt === undefined) {
      // Tokens first: they do not depend on the plan, and a deletion stopped at the next step still leaves them dead.
      const revoked = await (options.revoke ?? ((id) => revokeAccountTokens(id, fetcher)))(account).catch(() => false)
      // Then the cloud workspaces, whatever the revoke answered: from here the host refuses the account and stops its
      // engines, even while a step below keeps this run from reaching the erase. Best effort here; the `workspaces`
      // erase part takes this outcome, so it is recorded (and retried) like every other part.
      const workspacesClosed = await (
        options.closeWorkspaces ??
        ((id) =>
          closeCloudWorkspaces(id, fetcher, options.deadline === undefined ? {} : { deadline: options.deadline }))
      )(account).then(
        () => true,
        () => false,
      )
      if (revocationConfigured() && !revoked) return await pending("revoke")
      tokens = revoked ? "revoked" : "expire-within-90-days"
      if (store) {
        const closed = await (
          options.close ?? ((id) => reconcileModelPlanAccount(id, fetcher, clock(), { source: "request" }))
        )(account).then(
          () => true,
          () => false,
        )
        if (!closed) return await pending("close")
      }
      const cancelled = await (options.cancel ?? ((id) => cancelModelPlanAccount(id, fetcher)))(account).then(
        () => true,
        () => false,
      )
      if (!cancelled) return await pending("billing")
      const result = await eraseAccountData(account, {
        fetcher,
        now: clock(),
        pass: "erase",
        workspacesClosed,
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        ...(options.parts ? { parts: options.parts } : {}),
      })
      if (!result.erased) return await pending("erase", result.failed)
      if (record) {
        // The erase marker. Written before the identity goes, and the identity never goes without it.
        record = { v: 1, at: record.at, attempts: record.attempts, erasedAt: clock() }
        const marked = await saveTombstone(account, record, fetcher).then(
          () => true,
          () => false,
        )
        if (!marked) return await pending("erase")
      }
    }
    const usage = (await (options.forget ?? ((id) => forgetUsage(id, fetcher)))(account).catch(() => false))
      ? "deleted"
      : "deletion-failed"
    const identity =
      options.identity ??
      (async (id: string) => {
        const admin = identityAdmin()
        if (!admin) throw new ApiError(503, "DELETION_NOT_CONFIGURED", "Account deletion is not configured here.")
        await deleteAccountIdentity(admin, id, fetcher)
      })
    const deleted = await identity(account).then(
      () => true,
      () => false,
    )
    if (!deleted) return await pending("identity")
    if (record) {
      const now = clock()
      record = {
        v: 1,
        at: record.at,
        attempts: 0,
        ...(record.erasedAt ? { erasedAt: record.erasedAt } : {}),
        identityAt: now,
      }
      // The identity is gone; what follows is housekeeping, so a store hiccup here does not undo the answer.
      await saveTombstone(account, record, fetcher).catch(() => undefined)
      await scheduleTombstone(account, now + DELETION_RECHECK_MS, fetcher).catch(() => undefined)
    }
    return { state: "deleted", tokens, usage }
  } finally {
    if (token) await releaseDeletionLease(account, token, fetcher)
  }
}

/**
 * The follow-up pass, `DELETION_RECHECK_MS` after the identity went: every part erased again (each is idempotent, and
 * finds nothing unless a request already past its checks created something meanwhile), and the workspace host must
 * report every workspace of the account erased. Then the deletion is finished: off the cron's list, and the tombstone
 * kept `TOMBSTONE_KEEP_MS`.
 */
export async function checkAccountDeletion(account: string, options: DeletionOptions = {}): Promise<DeletionOutcome> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  let record = await readTombstone(account, fetcher)
  if (!record) {
    await unscheduleTombstone(account, fetcher)
    return { state: "checked" }
  }
  const token = await takeDeletionLease(account, DELETION_LEASE_MS, fetcher)
  if (!token) return { state: "busy" }
  try {
    const result = await eraseAccountData(account, {
      fetcher,
      now: clock(),
      pass: "check",
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      ...(options.parts ? { parts: options.parts } : {}),
    })
    if (!result.erased) {
      record = await recordFailure(account, record, "check", result.failed, fetcher, clock())
      return { state: "pending", stage: "check", failed: result.failed }
    }
    const { stage: _stage, failed: _failed, ...kept } = record
    await saveTombstone(account, { ...kept, attempts: 0, checkedAt: clock() }, fetcher, TOMBSTONE_KEEP_MS)
    await unscheduleTombstone(account, fetcher)
    return { state: "checked" }
  } finally {
    await releaseDeletionLease(account, token, fetcher)
  }
}

async function recordFailure(
  account: string,
  record: Tombstone,
  stage: DeletionStage,
  failed: string[],
  fetcher: typeof fetch,
  now: number,
) {
  const attempts = record.attempts + 1
  const next: Tombstone = { ...record, attempts, stage, ...(failed.length ? { failed } : {}) }
  if (!failed.length) delete next.failed
  // Best effort: a store that cannot be written now still has the deletion filed as due from before.
  await saveTombstone(account, next, fetcher).catch(() => undefined)
  await scheduleTombstone(account, now + deletionRetryMs(attempts), fetcher).catch(() => undefined)
  if (attempts >= DELETION_ALERT_AFTER)
    await notifyOwner(
      {
        kind: "account-deletion",
        subject: "A Vector account deletion is stuck",
        lines: [
          `Deleting account ${account} has failed ${attempts} times, last at the ${stage} step.`,
          ...(failed.length ? [`Parts not erased: ${failed.join(", ")}.`] : []),
          "The cleanup job keeps retrying every few hours. The usual cause is a service that is set up here but cannot be reached.",
        ],
        dedupeMs: RETRY_MAX_MS,
      },
      fetcher,
    ).catch(() => undefined)
  return next
}

export type DrainResult = { due: number; deleted: number; checked: number; pending: number; busy: number }

/**
 * The cleanup cron's pass: works through the deletions that are due, oldest first, within `budgetMs`. An unfinished
 * deletion continues where it stopped; a deletion whose identity is gone gets its follow-up pass. Answers counts only.
 */
export async function drainAccountDeletions(
  options: DeletionOptions & { budgetMs: number; limit?: number },
): Promise<DrainResult> {
  const fetcher = options.fetcher ?? fetch
  const clock = options.clock ?? Date.now
  const started = Date.now()
  const deadline = started + options.budgetMs
  const result: DrainResult = { due: 0, deleted: 0, checked: 0, pending: 0, busy: 0 }
  if (!storeConfigured()) return result
  const due = await dueTombstones(clock(), options.limit ?? 20, fetcher)
  result.due = due.length
  for (const account of due) {
    if (Date.now() >= deadline) break
    const record = await readTombstone(account, fetcher)
    if (!record || record.checkedAt !== undefined) {
      await unscheduleTombstone(account, fetcher)
      continue
    }
    const step = { ...options, fetcher, clock, deadline }
    const outcome =
      record.identityAt === undefined
        ? await finishAccountDeletion(account, step)
        : await checkAccountDeletion(account, step)
    if (outcome.state === "deleted") result.deleted++
    else if (outcome.state === "checked") result.checked++
    else if (outcome.state === "busy") result.busy++
    else result.pending++
  }
  return result
}
