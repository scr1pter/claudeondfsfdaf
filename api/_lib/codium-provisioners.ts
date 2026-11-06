import { codiumKey } from "./codium-keys.js"
import { notifyOwner, ownerAlertsConfigured } from "./codium-owner.js"
import { OUTBOX_SCRIPTS, registerProvisioner, type PerkProvisioner, type Transition } from "./codium-provision.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * The provisioners (contract §4.8): one per service that follows the plan cache, each converging its service to the
 * snapshot reconcile wrote (§4.4's per-service table). Every configured one gets an outbox item, in the same EVAL as
 * each new snapshot version, and the outbox runs it (codium-provision.ts).
 *
 * WP A06 builds `github-runs` and `owner-notify`. The others are stubs, not configured, so they get no items: each
 * service's work package replaces its stub here (remote A40, founding, vault, hosted, ops, push) and the daily sweep
 * then catches every account up to its snapshot.
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

// ── Stubs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A service not built yet: never configured, so it gets no items and does nothing. */
function stub(id: string): PerkProvisioner {
  return { id, configured: () => false, apply: async () => {} }
}

/** Every provisioner, in the order their items are written. */
export const PROVISIONERS: readonly PerkProvisioner[] = [
  githubRuns,
  stub("remote"),
  stub("push"),
  stub("vault"),
  stub("hosted"),
  stub("ops"),
  stub("founding"),
  ownerNotify,
]

for (const provisioner of PROVISIONERS) registerProvisioner(provisioner)
