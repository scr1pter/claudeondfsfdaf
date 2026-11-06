import { codiumKey } from "./codium-keys.js"
import { persistentStore } from "./persistent-store.js"

/*
 * Owner alerts for Vector Codium (contract §4.6 `owner:alert:<kind>`). WP A06 starts this module with the one sender
 * the outbox needs: dead letters and the `owner-notify` provisioner. WP A11 generalises the funding check's email into
 * it. An alert names accounts by id only, never by email. Funding amounts are private to the owner's email; other
 * provisioner alerts carry no amounts. Nothing this sender returns exposes the email contents.
 */

/** What became of an alert: sent now, sent before (deduplicated), not configured here, or the send failed. */
export type OwnerAlertResult = "sent" | "duplicate" | "unconfigured" | "failed"

export type OwnerAlert = {
  /** Deduplication: the same kind is sent once within `dedupeMs`. A key part: no spaces. */
  kind: string
  subject: string
  lines: readonly string[]
  dedupeMs?: number
}

const DEFAULT_DEDUPE_MS = 24 * 3_600_000

/** Where the owner's email goes from, and to: the same settings the funding check uses. */
function ownerEmail() {
  const key = process.env.RESEND_API_KEY?.trim()
  const from = process.env.VECTOR_PURCHASE_EMAIL_FROM?.trim()
  const to = process.env.CODIUM_OWNER_EMAIL?.trim() || process.env.VECTOR_BUG_REPORT_TO?.trim()
  return key && from && to ? { key, from, to } : undefined
}

/** Whether owner alerts can be sent from this deployment. */
export function ownerAlertsConfigured() {
  return ownerEmail() !== undefined
}

/**
 * Emails the owner once per `kind` within `dedupeMs`. The dedupe mark is taken before sending and given back when the
 * send fails, so a caller that retries (the outbox does) sends it later, and two callers at once send it once.
 */
export async function notifyOwner(alert: OwnerAlert, fetcher: typeof fetch = fetch): Promise<OwnerAlertResult> {
  const email = ownerEmail()
  if (!email) return "unconfigured"
  const mark = codiumKey("owner", "alert", alert.kind)
  const taken = await persistentStore(
    ["SET", mark, String(Date.now()), "NX", "PX", alert.dedupeMs ?? DEFAULT_DEDUPE_MS],
    fetcher,
  )
  if (taken !== "OK") return "duplicate"
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${email.key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: email.from, to: email.to, subject: alert.subject, text: alert.lines.join("\n") }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (response?.ok) return "sent"
  await persistentStore(["DEL", mark], fetcher).catch(() => undefined)
  return "failed"
}

export const OWNER_AUDIT_SCRIPT =
  "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3]) redis.call('PEXPIRE', KEYS[1], ARGV[4]) return 1"
