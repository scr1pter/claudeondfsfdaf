import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import {
  OPS_INTERNAL_PREFIX,
  type ConfigBody,
  type OpsAction,
  type OpsPlan,
  type ReleaseAnswer,
  type ReleaseBody,
} from "../../packages/ops-worker/src/protocol.js"
import { readSwitch } from "./codium-switches.js"
import { internalConfigured, internalFetch } from "./hosted-internal.js"
import { ApiError } from "./http.js"

/*
 * Vector's server side of the ops Worker (WP A47; the Worker is A46, `packages/ops-worker`, and its interface is
 * `packages/ops-worker/src/protocol.ts`). Every call is one of the Worker's signed internal actions (A37's HMAC under the
 * `ops` service key, VECTOR_OPS_SHARED_SECRET), sent to `<VECTOR_OPS_WORKER_URL>/internal/v1/<action>`. A47 sends:
 *
 *   config {account, domains, monitors}   the verified domains and On Call URLs (ops-settings.ts), after every change
 *   release {account, repositoryId, ...}   a production deployment that succeeded (github-webhook-handlers/ops.ts)
 *   flags {kill}                           the owner's `ops` switch (codium-owner-api.ts)
 *
 * A48 adds `plan` (the ops provisioner, codium-provisioners.ts, from `opsPlanFor`) and `erase` (the same provisioner on
 * account deletion). `state` and `suspend` belong to the screens and the guard (A50); `opsCall` is ready for them.
 * Nothing here logs an account, a URL or an answer.
 */

const ACCOUNT = /^[\x21-\x7e]{1,128}$/
const ANSWER_BYTES = 64 * 1024
const RELEASE_REASONS = new Set(["not-in-plan", "off", "stale", "older", "duplicate", "daily-limit", "not-verified"])

/** VECTOR_OPS_ENABLED=true: the owner says the ops services are set up. The `ops` switch turns them off at runtime. */
export function opsEnabled() {
  return process.env.VECTOR_OPS_ENABLED === "true"
}

/**
 * The Worker's origin from VECTOR_OPS_WORKER_URL: `https:` with no path, query or credentials (plain `http:` to
 * localhost only outside production, for a local Worker). Undefined when it is missing or not valid.
 */
export function opsWorkerOrigin(): URL | undefined {
  const value = process.env.VECTOR_OPS_WORKER_URL?.trim()
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const production = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production"
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && !production)) return undefined
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    return undefined
  return new URL(url.origin)
}

/** Whether this server can call the Worker: VECTOR_OPS_ENABLED, its address and the shared secret. */
export function opsConfigured() {
  return opsEnabled() && opsWorkerOrigin() !== undefined && internalConfigured("ops")
}

function unavailable() {
  return new ApiError(503, "OPS_UNAVAILABLE", "Vector's production checks are temporarily unavailable.")
}

/**
 * Refuses with 503 `OPS_UNAVAILABLE` while the ops services are not configured, and `OPS_PAUSED` while the owner's `ops`
 * switch is off. Writes that add work check this; removing settings and reading them never do.
 */
export async function requireOpsService(fetcher: typeof fetch = fetch, now = Date.now()) {
  if (!opsConfigured()) throw unavailable()
  if ((await readSwitch("ops", fetcher, { now })) !== "on")
    throw new ApiError(503, "OPS_PAUSED", "Vector's production checks are paused. Try again later.")
}

/**
 * One signed call to the Worker. The answer must be a 2xx JSON object; anything else (the Worker unreachable, a
 * refusal, a malformed answer) is 503 `OPS_UNAVAILABLE`, so a caller never acts on a half-applied change.
 */
export async function opsCall(
  action: OpsAction,
  body: Readonly<Record<string, unknown>>,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  const origin = opsWorkerOrigin()
  if (!opsEnabled() || !origin || !internalConfigured("ops")) throw unavailable()
  if (action !== "flags" && (typeof body.account !== "string" || !ACCOUNT.test(body.account))) throw unavailable()
  let response: Response
  try {
    response = await internalFetch(
      "ops",
      new URL(`${OPS_INTERNAL_PREFIX}${action}`, origin),
      { method: "POST", body: JSON.stringify(body) },
      fetcher,
      now,
    )
  } catch {
    throw unavailable()
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw unavailable()
  }
  const text = await response.text().catch(() => "")
  if (!text || text.length > ANSWER_BYTES) throw unavailable()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw unavailable()
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable()
  return parsed as Record<string, unknown>
}

/** Replaces the account's verified domains and On Call URLs on the Worker. Answers how many monitors it now probes. */
export async function opsConfig(body: ConfigBody, fetcher: typeof fetch = fetch, now = Date.now()) {
  const answer = await opsCall("config", body, fetcher, now)
  if (!Number.isSafeInteger(answer.monitors)) throw unavailable()
  return {
    monitors: answer.monitors as number,
    probed: Number.isSafeInteger(answer.probed) ? (answer.probed as number) : 0,
  }
}

/** Asks the Worker to watch a production release (Release Guard). Its answer says whether it will, or why not. */
export async function opsRelease(body: ReleaseBody, fetcher: typeof fetch = fetch, now = Date.now()) {
  const answer = await opsCall("release", body, fetcher, now)
  if (answer.accepted === true && Number.isSafeInteger(answer.startAt) && Number.isSafeInteger(answer.endAt))
    return { accepted: true, startAt: answer.startAt as number, endAt: answer.endAt as number } satisfies ReleaseAnswer
  if (answer.accepted === false && typeof answer.reason === "string" && RELEASE_REASONS.has(answer.reason))
    return { accepted: false, reason: answer.reason } as ReleaseAnswer
  throw unavailable()
}

/**
 * Copies the owner's `ops` switch to the Worker's own kill flag, which every account reads at each wake. The switch
 * already stops new settings and releases here; "failed" tells the owner to apply it again (or to set the flag
 * directly, owner-actions/hosted-ops.md).
 */
export async function syncOpsKillFlag(
  switchedOff: boolean,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<"updated" | "failed" | "not-configured"> {
  if (!opsConfigured()) return "not-configured"
  try {
    const answer = await opsCall("flags", { kill: switchedOff }, fetcher, now)
    return answer.kill === switchedOff ? "updated" : "failed"
  } catch {
    return "failed"
  }
}

const DAY_MS = 86_400_000
/** A pushed plan lasts until the period's end plus this (A46: periodEnd + 24 h), so a lost update stops by itself. */
export const OPS_PLAN_GRACE_MS = DAY_MS
/**
 * While a payment is retried On Call keeps checking (§4.4), for at most this long from the push; the plan ends sooner
 * when the subscription ends. The Worker refuses a validUntil more than 40 days ahead.
 */
export const OPS_PAUSED_MS = 35 * DAY_MS
const OPS_MAX_AHEAD_MS = 39 * DAY_MS

/**
 * What the ops Worker may do for an account, from its entitlement snapshot (§4.4's On Call and Release Guard rows):
 * - active and renewing: the plan's On Call checks and Release Guard watches, until the period's end plus a day;
 * - paused: On Call keeps checking through Stripe's retry window, Release Guard starts no new watch;
 * - ended, frozen, no plan, or a plan without ops: nothing, from now.
 * Caps are the snapshot's own (ENTITLEMENTS ops, ramp applied), never the public copy, so a perk that is not listed yet
 * still has its caps here; nothing reaches the Worker until the account sets something up (H1 is the listing's job).
 */
export function opsPlanFor(snapshot: EntitlementSnapshot, now = Date.now()): OpsPlan {
  const ops = snapshot.plan ? snapshot.caps.ops : null
  const off: OpsPlan = {
    version: snapshot.version,
    domains: 0,
    onCall: null,
    releaseGuard: null,
    validUntil: Math.max(0, Math.min(now, snapshot.updatedAt)),
  }
  if (!ops) return off
  const onCall =
    ops.onCall.urls > 0 && ops.onCall.intervalSec > 0
      ? { urls: ops.onCall.urls, intervalSec: ops.onCall.intervalSec }
      : null
  const releaseGuard =
    ops.releaseGuard.perDay > 0 && ops.releaseGuard.watchMin > 0 && ops.releaseGuard.paths > 0
      ? { perDay: ops.releaseGuard.perDay, watchMin: ops.releaseGuard.watchMin, paths: ops.releaseGuard.paths }
      : null
  const domains = ops.onCall.domains
  if (snapshot.state === "active" || snapshot.state === "renewing")
    return {
      version: snapshot.version,
      domains,
      onCall,
      releaseGuard,
      validUntil: Math.min(snapshot.periodEnd + OPS_PLAN_GRACE_MS, now + OPS_MAX_AHEAD_MS),
    }
  if (snapshot.state === "paused")
    return { version: snapshot.version, domains, onCall, releaseGuard: null, validUntil: now + OPS_PAUSED_MS }
  return off
}
