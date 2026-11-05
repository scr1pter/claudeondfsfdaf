import {
  OPS_INTERNAL_PREFIX,
  type ConfigBody,
  type OpsAction,
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
 * `plan`, `state`, `suspend` and `erase` belong to the ops provisioner, the screens, the guard and account deletion
 * (A48, A50, A57); `opsCall` is ready for them. Nothing here logs an account, a URL or an answer.
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
