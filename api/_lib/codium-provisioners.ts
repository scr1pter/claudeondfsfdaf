import { codiumKey } from "./codium-keys.js"
import { eraseFounding, foundingOffered, syncFoundersListing } from "./codium-founding.js"
import { notifyOwner, ownerAlertsConfigured } from "./codium-owner.js"
import { OUTBOX_SCRIPTS, registerProvisioner, type PerkProvisioner, type Transition } from "./codium-provision.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"
import { relayConfigured, relayErase, relayKill, relaySuspend, type RelaySuspendReason } from "./remote-relay.js"
import { eraseAccountOpsRecords } from "./ops-incidents.js"
import { eraseAccountOpsSettings } from "./ops-settings.js"
import { eraseAccountShipDesk } from "./ship-desk.js"
import { opsCall, opsConfigured, opsPlanFor } from "./ops-worker.js"
import { eraseAccountVault, holdVault, lapseVault, releaseVault, vaultStoreConfigured } from "./vault-store.js"
import { eraseAccountPushSubscriptions, pushConfigured } from "./web-push.js"
import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"

/*
 * The provisioners (contract §4.8): one per service that follows the plan cache, each converging its service to the
 * snapshot reconcile wrote (§4.4's per-service table). Every configured one gets an outbox item, in the same EVAL as
 * each new snapshot version, and the outbox runs it (codium-provision.ts).
 *
 * WP A06 builds `github-runs` and `owner-notify`; WP A31 builds `founding`; WP A37 builds `push`; WP A40 builds
 * `remote`; WP A44 builds `vault`; WP A48 builds `ops`. The others are stubs, not configured, so they get no items: each
 * service's work package replaces its stub here (hosted) and the daily sweep then catches every account up to its
 * snapshot.
 */

const DAY_MS = 86_400_000

// ── github-runs ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How long the run-token revocation mark is kept. A run token lives as long as one run (two hours at most on any plan),
 * so a mark this old can no longer refuse anything the snapshot would not also refuse.
 */
export const RUN_TOKEN_REVOCATION_KEEP_MS = 35 * DAY_MS
/** `runs:revoked-before:<account>`: run tokens issued before this time (ms) are invalid. */
export const runTokensRevokedKey = (account: string) => codiumKey("runs", "revoked-before", account)

/**
 * `github-runs`: makes the snapshot's `revokedBefore` (set when an account is frozen) a mark run-token checks read
 * with one GET, so a run token (Codex's `vrt_`, the gateway's run callers) issued before a freeze stops working at its
 * next request, mint, heartbeat or report. The mark only ever moves forward. Everything else in the run-token row of
 * §4.4 (mints refused while paused, ended or frozen; 402 on a running run's next request) is read from the snapshot
 * itself by `cloudAgentAllowance` and the gateway.
 */
export const githubRuns: PerkProvisioner = {
  id: "github-runs",
  configured: () => true,
  async apply(t, fetcher = fetch) {
    const before = t.to.revokedBefore
    if (before === undefined) return
    const raised = await persistentStore(
      ["EVAL", OUTBOX_SCRIPTS.RAISE, 1, runTokensRevokedKey(t.account), before, RUN_TOKEN_REVOCATION_KEEP_MS],
      fetcher,
    )
    if (raised !== 0 && raised !== 1)
      throw new ApiError(503, "CODIUM_OUTBOX_UNAVAILABLE", "The Vector Codium outbox could not be read.")
  },
}

/**
 * When run tokens issued earlier stopped being valid for this account (ms), or undefined when none were revoked. An
 * unreadable mark fails closed (503) rather than letting a revoked token through.
 */
export async function runTokensRevokedBefore(account: string, fetcher: typeof fetch = fetch) {
  const stored = await persistentStore(["GET", runTokensRevokedKey(account)], fetcher)
  if (stored === null || stored === undefined) return undefined
  const at = Number(stored)
  if (!Number.isSafeInteger(at) || at < 0)
    throw new ApiError(503, "CODIUM_OUTBOX_UNAVAILABLE", "The Vector Codium outbox could not be read.")
  return at
}

/** Whether a run token issued at `issuedAt` (ms) for this account has been revoked. */
export async function runTokenRevoked(account: string, issuedAt: number, fetcher: typeof fetch = fetch) {
  const before = await runTokensRevokedBefore(account, fetcher)
  return before !== undefined && issuedAt < before
}

// ── owner-notify ───────────────────────────────────────────────────────────────────────────────────────────────────

const HOLD_REASONS: Record<string, string> = {
  disputed: "a payment dispute is open",
  early_fraud_warning: "Stripe sent an early fraud warning",
  owner: "the owner's block or a risk block holds it",
}
const RISK_ENDINGS: Record<string, string> = {
  disputed: "a payment dispute was lost",
  early_fraud_warning: "it was ended after an early fraud warning",
  refunded: "its current month was fully refunded",
}

/**
 * What the owner should hear about a change, or undefined: an account put on hold (a dispute, an early fraud warning,
 * a block), an account ended by a lost dispute, a fraud warning or a full refund, and an account released from a hold.
 * Accounts are named by id only; nothing carries an email or an amount.
 */
export function ownerNotice(t: Transition): { subject: string; lines: string[] } | undefined {
  const { from, to } = t
  const before = from ? `${from.state}${from.reason ? ` (${from.reason})` : ""}` : "unknown"
  const details = [
    `Account: ${t.account}`,
    `Plan: ${to.plan ?? "none"}`,
    `State: ${before} -> ${to.state}${to.reason ? ` (${to.reason})` : ""}`,
    `Cause: ${t.cause}`,
    `Snapshot version: ${to.version}`,
    "",
    "Accounts are named by id only. Stripe's dashboard has the customer, charges and disputes.",
  ]
  if (to.state === "frozen" && (from?.state !== "frozen" || from.reason !== to.reason))
    return {
      subject: `Vector Codium: an account is on hold (${to.reason ?? "owner"})`,
      lines: [
        `Vector Codium put an account on hold because ${HOLD_REASONS[to.reason ?? "owner"] ?? HOLD_REASONS.owner}. Its key is off and run tokens issued before now are revoked.`,
        "",
        ...details,
      ],
    }
  if (
    to.state === "ended" &&
    to.reason &&
    RISK_ENDINGS[to.reason] &&
    (from?.state !== "ended" || from.reason !== to.reason)
  )
    return {
      subject: `Vector Codium: an account ended (${to.reason})`,
      lines: [`Vector Codium ended an account's plan because ${RISK_ENDINGS[to.reason]}.`, "", ...details],
    }
  if (from?.state === "frozen" && to.state !== "frozen")
    return {
      subject: "Vector Codium: an account is no longer on hold",
      lines: [`An account Vector Codium had on hold is now ${to.state}.`, "", ...details],
    }
  return undefined
}

/**
 * `owner-notify`: tells the owner about the changes `ownerNotice` names, once per account and snapshot version (a
 * retried or re-queued item never sends twice). A send that fails is retried by the outbox.
 */
export const ownerNotify: PerkProvisioner = {
  id: "owner-notify",
  configured: ownerAlertsConfigured,
  async apply(t, fetcher = fetch) {
    const notice = ownerNotice(t)
    if (!notice) return
    const sent = await notifyOwner(
      { kind: `account:${t.account}:${t.to.version}`, ...notice, dedupeMs: 35 * DAY_MS },
      fetcher,
    )
    if (sent === "failed") throw new ApiError(503, "CODIUM_OWNER_ALERT_FAILED", "The owner alert could not be sent.")
  },
}

// ── founding ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `founding` (WP A31, §4.4's Founding row): keeps the opt-in founders page in line with the plan state. A founder who
 * chose to be listed is shown while the plan is active, renewing, paused or ended-but-not-deleted, hidden while it is
 * frozen, and taken off once the membership ended (reconcile marks that when its subscription is deleted). Account
 * deletion (`closing`) erases the record, the entry and the display name (P5). Configured while the owner lists
 * `founding`. It is the quick path, not the only one: reconcile (`settleFounding`) converges a founder's entry with the
 * plan state on every pass and account deletion erases the record itself, so taking `founding` out of
 * `CODIUM_LISTED_PERKS` after the window closes never leaves a frozen founder on the page.
 */
export const founding: PerkProvisioner = {
  id: "founding",
  configured: foundingOffered,
  async apply(t, fetcher = fetch) {
    if (t.to.reason === "closing") return eraseFounding(t.account, fetcher)
    await syncFoundersListing(t.account, t.to.state === "frozen", fetcher)
  },
}

// ── push ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `push` (WP A37, §4.4's Phone alerts row): every send reads the snapshot itself (active and renewing send; paused,
 * ended and frozen do not), so the only state to converge is deletion: an account being deleted (`closing`) loses its
 * push subscriptions (P5). Configured while the VAPID keys are.
 */
export const push: PerkProvisioner = {
  id: "push",
  configured: () => pushConfigured(),
  async apply(t, fetcher = fetch) {
    if (t.to.reason === "closing") await eraseAccountPushSubscriptions(t.account, fetcher)
  },
}

// ── remote ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the relay should hold for a snapshot: a suspension while paused or frozen (§4.4's Remote relay row). */
export function relaySuspension(snapshot: EntitlementSnapshot | undefined): RelaySuspendReason | undefined {
  if (snapshot?.state === "paused") return "paused"
  if (snapshot?.state === "frozen") return snapshot.reason === "owner" ? "owner" : "frozen"
  return undefined
}

/**
 * `remote` (WP A40, §4.4's Remote relay row), converging the account's relay object to the snapshot:
 * - active and renewing: no suspension (tickets are minted only while the plan allows Remote);
 * - paused: suspended, so paid sessions close and are refused until the payment is fixed;
 * - frozen: suspended, and connections from tickets issued before `revokedBefore` closed for good;
 * - ended (or no plan any more): every connection from a ticket issued before the change closed (no new ticket can be
 *   minted), and any suspension lifted, so a returning subscriber connects again;
 * - account deletion (`closing`): everything the relay holds for the account erased (P5).
 * Each call is made only when the change needs it, or always when the previous snapshot is unknown (the sweep's
 * catch-up), and every one is idempotent: a suspension is ordered by the snapshot's `updatedAt`, and a revocation time
 * only moves forward at the relay. Configured while the relay can be called (its address and the internal secret).
 */
export const remote: PerkProvisioner = {
  id: "remote",
  configured: () => relayConfigured(),
  async apply(t, fetcher = fetch) {
    const { from, to } = t
    if (to.state === "ended" && to.reason === "closing") return relayErase(t.account, fetcher)
    if (to.state === "none" && (!from || from.state === "none")) return
    if (to.revokedBefore !== undefined && (!from || from.revokedBefore !== to.revokedBefore))
      await relayKill(t.account, to.revokedBefore, fetcher)
    const ended = to.state === "ended" || to.state === "none"
    if (ended && (!from || (from.state !== "ended" && from.state !== "none")))
      await relayKill(t.account, to.updatedAt, fetcher)
    const suspension = relaySuspension(to)
    if (!from || relaySuspension(from) !== suspension)
      await relaySuspend(
        t.account,
        { suspended: suspension !== undefined, ...(suspension ? { reason: suspension } : {}), at: to.updatedAt },
        fetcher,
      )
  },
}

// ── vault ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the vault should hold for a snapshot (§4.4's Brain Vault row). */
export function vaultPolicy(snapshot: EntitlementSnapshot | undefined): "erase" | "hold" | "release" | "lapse" {
  if (snapshot?.state === "ended" && snapshot.reason === "closing") return "erase"
  if (snapshot?.state === "frozen") return "hold"
  if (snapshot?.state === "active" || snapshot?.state === "renewing" || snapshot?.state === "paused") return "release"
  return "lapse"
}

/**
 * `vault` (WP A44, §4.4's Brain Vault row), converging the account's vault (vault-store.ts) to the snapshot. Uploads
 * themselves are decided by each request from the snapshot; this keeps what the daily cleanup may delete in line:
 * - active, renewing and paused: no hold and no deletion date (paused refuses uploads and keeps everything);
 * - frozen: held, so nothing is deleted, not even versions past their days, until the dispute or warning is settled;
 * - ended (or no plan any more): read-only for 30 days counted from an emailed notice, sent once, then deleted by the
 *   cleanup; a plan that starts again before then clears the date;
 * - account deletion (`closing`): the vault is erased at once, the wrapped key first (P5).
 * A call is made only when the policy changes, or always when the previous snapshot is unknown (the sweep's
 * catch-up); each is idempotent. Configured while the store is, so erasure still works after Vault is turned off.
 */
export const vault: PerkProvisioner = {
  id: "vault",
  configured: () => vaultStoreConfigured(),
  async apply(t, fetcher = fetch) {
    const { from, to } = t
    const policy = vaultPolicy(to)
    if (policy === "erase") return void (await eraseAccountVault(t.account, { fetcher }))
    if (to.state === "none" && (!from || from.state === "none")) return
    if (from && vaultPolicy(from) === policy && policy !== "lapse") return
    if (policy === "hold") return holdVault(t.account, { fetcher })
    if (policy === "release") return releaseVault(t.account, { fetcher })
    await lapseVault(t.account, { fetcher, version: to.version })
  },
}

// ── ops ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `ops` (WP A48, §4.4's On Call and Release Guard rows): pushes the ops Worker the plan the snapshot allows
 * (ops-worker.ts `opsPlanFor`): checks and watches while active or renewing, checks only while paused, nothing once
 * ended or frozen. The Worker keeps the newest version and stops by itself at `validUntil`. An account that has never
 * had ops caps has nothing at the Worker, so it is not called. Account deletion (`closing`) erases the Worker's data,
 * the ops settings, every ops record and Ship Desk's cards with their images (P5). Configured while the Worker can be
 * called. Ship Desk needs nothing pushed: its cards follow the snapshot when they are made (ship-desk.ts).
 */
export const ops: PerkProvisioner = {
  id: "ops",
  configured: () => opsConfigured(),
  async apply(t, fetcher = fetch) {
    const { from, to } = t
    if (to.state === "ended" && to.reason === "closing") {
      await opsCall("erase", { account: t.account }, fetcher)
      await eraseAccountOpsSettings(t.account, fetcher)
      await eraseAccountOpsRecords(t.account, fetcher)
      // WP A49: Ship Desk's cards, their images in vector-media, run claims and capture tickets.
      await eraseAccountShipDesk(t.account, fetcher)
      return
    }
    if (!to.caps.ops && (!from || !from.caps.ops)) return
    await opsCall("plan", { account: t.account, plan: opsPlanFor(to) }, fetcher)
  },
}

// ── Stubs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A service not built yet: never configured, so it gets no items and does nothing. */
function stub(id: string): PerkProvisioner {
  return { id, configured: () => false, apply: async () => {} }
}

/** Every provisioner, in the order their items are written. */
export const PROVISIONERS: readonly PerkProvisioner[] = [
  githubRuns,
  remote,
  push,
  vault,
  stub("hosted"),
  ops,
  founding,
  ownerNotify,
]

for (const provisioner of PROVISIONERS) registerProvisioner(provisioner)
