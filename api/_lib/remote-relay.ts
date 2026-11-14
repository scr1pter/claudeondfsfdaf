import { internalConfigured, internalFetch } from "./hosted-internal.js"
import { ApiError } from "./http.js"

/*
 * Vector's server side of the Remote relay Worker (WP A40; the Worker is A39, `packages/relay`). Every call is one of
 * the Worker's signed internal actions (A37's HMAC under the `relay` service key), sent to
 * `https://<relay>/internal/v1/<action>`:
 *
 *   kill {account, before}                     close every connection and refuse tickets issued before `before` (ms)
 *   suspend {account, suspended, reason, at}   paused, frozen or an owner hold (contract §4.4); ordered by `at`
 *   presence {account}                         whether a computer is connected (`isComputerOnline`, §4.17)
 *   devices {account}                          the paired devices, in pairing order
 *   revoke-device {account, device}            one device closed and refused for good
 *   erase {account}                            everything the account's object holds (P5)
 *   flags {kill}                               the Worker's kill flag (the owner's `remote` switch)
 *
 * The relay's address is VECTOR_REMOTE_RELAY_URL, its `wss://` origin; tickets connect to `<origin>/v1/connect` and the
 * internal calls go to the same host over https. This module imports nothing that reads the plan, so account
 * revocation (revocation.ts) can close relay sockets without an import cycle. Nothing here logs an account or a body.
 */

export const RELAY_SUBPROTOCOL = "vector.v1"
export const RELAY_CONNECT_PATH = "/v1/connect"
const INTERNAL_PREFIX = "/internal/v1/"
const RELAY_ANSWER_BYTES = 64 * 1024
/** The relay's own device id form: 16 random bytes, base64url without padding. */
export const RELAY_DEVICE_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/
const ACCOUNT = /^[\x21-\x7e]{1,128}$/

export type RelayAction = "kill" | "suspend" | "presence" | "devices" | "revoke-device" | "erase" | "flags"
export type RelaySuspendReason = "paused" | "frozen" | "owner"
export type RelayAddress = { socket: string; internal: URL }

/**
 * The relay's address from VECTOR_REMOTE_RELAY_URL: a `wss:` origin with no path, query or credentials (plain `ws:` to
 * localhost only outside production, for a local Worker). Undefined when it is missing or not valid.
 */
export function relayAddress(): RelayAddress | undefined {
  const value = process.env.VECTOR_REMOTE_RELAY_URL?.trim()
  if (!value) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const production = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production"
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && local && !production)) return undefined
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    return undefined
  const internal = new URL(`${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`)
  return { socket: `${url.protocol}//${url.host}${RELAY_CONNECT_PATH}`, internal }
}

/** Whether this server can call the relay: its address and the internal secret (VECTOR_HOSTED_INTERNAL_SECRET). */
export function relayConfigured() {
  return relayAddress() !== undefined && internalConfigured("relay")
}

function unavailable() {
  return new ApiError(503, "REMOTE_UNAVAILABLE", "Vector Remote is temporarily unavailable.")
}

/**
 * One signed call to the relay. The answer must be a 2xx JSON object; anything else (the relay unreachable, a refusal,
 * a malformed answer) is 503 `REMOTE_UNAVAILABLE`, so a caller never acts on a half-applied change.
 */
export async function relayCall(
  action: RelayAction,
  body: Readonly<Record<string, unknown>>,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  const address = relayAddress()
  if (!address || !internalConfigured("relay")) throw unavailable()
  if (action !== "flags" && (typeof body.account !== "string" || !ACCOUNT.test(body.account))) throw unavailable()
  let response: Response
  try {
    response = await internalFetch(
      "relay",
      new URL(`${INTERNAL_PREFIX}${action}`, address.internal),
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
  if (!text || text.length > RELAY_ANSWER_BYTES) throw unavailable()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw unavailable()
  }
  if (!isRecord(parsed)) throw unavailable()
  return parsed
}

// ── Actions ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Closes every connection of the account whose ticket was issued before `before` (ms) and refuses such tickets from
 * then on. The relay never takes a time later than its own clock, and a revocation time there only moves forward.
 */
export async function relayKill(account: string, before: number, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (!Number.isSafeInteger(before) || before < 0) throw unavailable()
  const answer = await relayCall("kill", { account, before }, fetcher, now)
  return { revokedBefore: count(answer.revokedBefore), closed: count(answer.closed) }
}

/** Suspends the account's relay (closing every connection) or lifts the suspension. `at` orders the updates. */
export async function relaySuspend(
  account: string,
  input: { suspended: boolean; reason?: RelaySuspendReason; at: number },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(input.at) || input.at <= 0) throw unavailable()
  const answer = await relayCall(
    "suspend",
    { account, suspended: input.suspended, reason: input.reason ?? "paused", at: input.at },
    fetcher,
    now,
  )
  if (typeof answer.suspended !== "boolean") throw unavailable()
  return { applied: answer.applied === true, suspended: answer.suspended, closed: count(answer.closed) }
}

/** Deletes everything the account's relay object holds and closes its connections (P5). */
export async function relayErase(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const answer = await relayCall("erase", { account }, fetcher, now)
  if (answer.erased !== true) throw unavailable()
}

/** Sets or clears the Worker's kill flag. */
export async function relayKillFlag(kill: boolean, fetcher: typeof fetch = fetch, now = Date.now()) {
  const answer = await relayCall("flags", { kill }, fetcher, now)
  if (answer.kill !== kill) throw unavailable()
}

export type RelayPresence = { online: boolean; computers: { device: string; name?: string }[]; viewers: number }

/** The relay half of `isComputerOnline` (§4.17): which of the account's computers are connected now. */
export async function relayPresence(
  account: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RelayPresence> {
  const answer = await relayCall("presence", { account }, fetcher, now)
  if (typeof answer.online !== "boolean" || !Array.isArray(answer.computers)) throw unavailable()
  const computers = answer.computers.flatMap((entry) =>
    isRecord(entry) && typeof entry.device === "string" && RELAY_DEVICE_ID.test(entry.device)
      ? [{ device: entry.device, ...(deviceName(entry.name) ? { name: entry.name as string } : {}) }]
      : [],
  )
  return { online: answer.online && computers.length > 0, computers, viewers: count(answer.viewers) }
}

/**
 * Whether any of the account's computers is connected to the relay now (§4.17's presence entry point, for offering a
 * job to an online computer later). False when Remote is not configured or the relay cannot be asked: a caller then
 * treats the computer as offline, never as available.
 */
export async function isComputerOnline(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (!relayConfigured()) return false
  try {
    return (await relayPresence(account, fetcher, now)).online
  } catch {
    return false
  }
}

export type RelayDevice = {
  device: string
  role: "computer" | "phone"
  name?: string
  key?: string
  pairedAt: number
  lastSeen: number
  online: boolean
  overLimit: boolean
}
export type RelayDevices = {
  devices: RelayDevice[]
  limits: { computers: number; phones: number }
  fairUse: "ok" | "viewer" | "awake"
}

/** The account's paired devices, in pairing order per role, as the relay holds them. Malformed entries are dropped. */
export async function relayDevices(
  account: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RelayDevices> {
  const answer = await relayCall("devices", { account }, fetcher, now)
  if (!Array.isArray(answer.devices) || !isRecord(answer.limits)) throw unavailable()
  const devices = answer.devices.flatMap((entry): RelayDevice[] => {
    if (
      !isRecord(entry) ||
      typeof entry.device !== "string" ||
      !RELAY_DEVICE_ID.test(entry.device) ||
      (entry.role !== "computer" && entry.role !== "phone") ||
      !Number.isSafeInteger(entry.pairedAt) ||
      !Number.isSafeInteger(entry.lastSeen) ||
      typeof entry.online !== "boolean" ||
      typeof entry.overLimit !== "boolean"
    )
      return []
    return [
      {
        device: entry.device,
        role: entry.role,
        ...(deviceName(entry.name) ? { name: entry.name as string } : {}),
        ...(typeof entry.key === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(entry.key) ? { key: entry.key } : {}),
        pairedAt: entry.pairedAt as number,
        lastSeen: entry.lastSeen as number,
        online: entry.online,
        overLimit: entry.overLimit,
      },
    ]
  })
  const fairUse = answer.fairUse === "viewer" || answer.fairUse === "awake" ? answer.fairUse : "ok"
  return {
    devices,
    limits: { computers: count(answer.limits.computers), phones: count(answer.limits.phones) },
    fairUse,
  }
}

/** Revokes one device: its connections close and its id is refused from now on. */
export async function relayRevokeDevice(
  account: string,
  device: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  if (!RELAY_DEVICE_ID.test(device)) throw unavailable()
  const answer = await relayCall("revoke-device", { account, device }, fetcher, now)
  if (answer.revoked !== true) throw unavailable()
  return { revoked: true as const, closed: count(answer.closed) }
}

/**
 * Account revocation's half of S6 ("a revoked account cannot mint a ticket and its sockets close"): closes every
 * connection the account has and refuses tickets issued before now. Best effort, never throws: false when Remote is
 * not configured or the relay could not be reached. The revocation mark stops new tickets on its own, and a phone
 * whose ticket cannot be refreshed is closed within a minute of its expiry (five minutes at most).
 */
export async function killRelaySessions(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  if (!relayConfigured()) return false
  try {
    await relayKill(account, now, fetcher, now)
    return true
  } catch {
    return false
  }
}

/**
 * Brings the Worker's kill flag in line with the owner's `remote` switch: set while the switch is off. Answers what
 * happened instead of throwing, so a switch change is never undone by an unreachable relay; the owner can apply the
 * switch again, or set the flag directly (owner-actions/remote.md).
 */
export async function syncRelayKillFlag(
  switchedOff: boolean,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<"updated" | "failed" | "not-configured"> {
  if (!relayConfigured()) return "not-configured"
  try {
    await relayKillFlag(switchedOff, fetcher, now)
    return "updated"
  } catch {
    return "failed"
  }
}

function deviceName(value: unknown) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
}

function count(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
