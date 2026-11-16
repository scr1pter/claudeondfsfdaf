import { luaKeyTypes } from "./lua.js"
import {
  ACCOUNT_ID_PATTERN,
  DECLINE_CODES,
  DEVICE_ID_PATTERN,
  JOB_ID_PATTERN,
  JOB_STATES,
  OUTCOMES,
  PLATFORMS,
  REFUSAL_CODES,
  ROUTES,
  installationPlatform,
  randomId,
  type Decoded,
  type PlatformId,
} from "../../../packages/schema/src/everywhere.js"
import { ENDINGS } from "../../../packages/schema/src/everywhere-policy.js"
import { AUDIT_MAX_ENTRIES, KEEP_MS, USER_ID_PATTERNS, everywhereKeys } from "./keys.js"
import { storeInteger, storeUnavailable, type Store } from "./store.js"
import { ApiError } from "../http.js"
import { accountGuards, authorizedScript, type AccountAuthorityPort } from "./authority.js"

/*
 * The audit log (contract E16, 3.13). Every install, connect, connector change, link, unlink, job accepted or refused,
 * route, offer, claim, decline, settle, post and erase is appended to the account's log with its time, platform,
 * installation, job id and code. An entry is ids and fixed codes only: it has no field that can hold text, and a field
 * outside the list below is refused. Kept 90 days, at most 1,000 entries per account.
 */

export const AUDIT_EVENTS = [
  "install",
  "uninstall",
  "connect",
  "disconnect",
  "connector-change",
  "link",
  "unlink",
  "job-accepted",
  "job-refused",
  "route",
  "offer",
  "claim",
  "decline",
  "settle",
  "post",
  "erase",
] as const
export type AuditEvent = (typeof AUDIT_EVENTS)[number]

/** Why an installation, link or record was erased (E13). */
export const ERASE_REASONS = [
  "uninstalled",
  "tokens-revoked",
  "revoked",
  "disconnected",
  "account-deleted",
  "unlinked",
] as const

/** Every code an entry may carry: fixed words only, so no message text can reach the log through a code. */
export const AUDIT_CODES: readonly string[] = [
  ...new Set<string>([
    ...REFUSAL_CODES,
    ...DECLINE_CODES,
    ...OUTCOMES,
    ...ROUTES,
    ...JOB_STATES,
    ...ENDINGS,
    ...ERASE_REASONS,
    /** A re-install by a platform admin replaced the connector (3.8). */
    "admin",
  ]),
]

/** What a caller records. Every field is an id or a fixed code. */
export type AuditInput = {
  readonly event: AuditEvent
  readonly platform?: PlatformId
  readonly installation?: string
  readonly jid?: string
  readonly code?: string
  /** The computer, for offers, claims, declines and settles. */
  readonly device?: string
  /** The Vector account that acted, when it is not the log's owner (a connector change, an admin re-install). */
  readonly actor?: string
  /** The platform user, by id, for links and unlinks. */
  readonly userId?: string
}

export type AuditEntry = AuditInput & { readonly id: string; readonly at: number }

const FIELDS = new Set(["event", "platform", "installation", "jid", "code", "device", "actor", "userId", "id", "at"])
const ENTRY_ID = /^[0-9a-z]{26}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Checks an entry (a new one or one read back). Unknown fields, text and malformed ids are refused. */
export function decodeAuditEntry(input: unknown): Decoded<AuditEntry> {
  if (!isRecord(input)) return { ok: false, error: "entry: not an object" }
  for (const field of Object.keys(input)) if (!FIELDS.has(field)) return { ok: false, error: `${field}: not allowed` }
  const { event, platform, installation, jid, code, device, actor, userId, id, at } = input
  if (typeof id !== "string" || !ENTRY_ID.test(id)) return { ok: false, error: "id: malformed" }
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return { ok: false, error: "at: malformed" }
  if (!(AUDIT_EVENTS as readonly unknown[]).includes(event)) return { ok: false, error: "event: unknown" }
  if (platform !== undefined && !(PLATFORMS as readonly unknown[]).includes(platform))
    return { ok: false, error: "platform: unknown" }
  let owner: PlatformId | undefined = platform as PlatformId | undefined
  if (installation !== undefined) {
    const of = installationPlatform(installation)
    if (!of || (owner !== undefined && owner !== of)) return { ok: false, error: "installation: malformed" }
    owner = of
  }
  if (jid !== undefined && (typeof jid !== "string" || !JOB_ID_PATTERN.test(jid)))
    return { ok: false, error: "jid: malformed" }
  if (code !== undefined && !AUDIT_CODES.includes(code as string)) return { ok: false, error: "code: unknown" }
  if (device !== undefined && (typeof device !== "string" || !DEVICE_ID_PATTERN.test(device)))
    return { ok: false, error: "device: malformed" }
  if (actor !== undefined && (typeof actor !== "string" || !ACCOUNT_ID_PATTERN.test(actor)))
    return { ok: false, error: "actor: malformed" }
  if (userId !== undefined && (typeof userId !== "string" || !owner || !USER_ID_PATTERNS[owner].test(userId)))
    return { ok: false, error: "userId: malformed" }
  const entry: AuditEntry = {
    id,
    at,
    event: event as AuditEvent,
    ...(owner !== undefined ? { platform: owner } : {}),
    ...(installation !== undefined ? { installation: installation as string } : {}),
    ...(jid !== undefined ? { jid: jid as string } : {}),
    ...(code !== undefined ? { code: code as string } : {}),
    ...(device !== undefined ? { device: device as string } : {}),
    ...(actor !== undefined ? { actor: (actor as string).toLowerCase() } : {}),
    ...(userId !== undefined ? { userId: userId as string } : {}),
  }
  return { ok: true, value: entry }
}

/**
 * Adds an entry and trims the log in one step: entries older than 90 days go, then the oldest beyond 1,000, and the
 * log's own expiry moves to 90 days from now. ARGV: score, member, cutoff, max entries, keep ms.
 */
export const AUDIT_APPEND_SCRIPT = luaKeyTypes(["zset"]) + [
  "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])",
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[3])",
  "local extra = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[4])",
  "if extra > 0 then redis.call('ZREMRANGEBYRANK', KEYS[1], 0, extra - 1) end",
  "redis.call('PEXPIRE', KEYS[1], ARGV[5])",
  "return redis.call('ZCARD', KEYS[1])",
].join(" ")

/** Appends an entry to `account`'s log. Throws (a programming error) when the entry is not allowed. */
export async function appendAudit(store: Store, account: string, input: AuditInput, now = Date.now(), accountAuthority?: AccountAuthorityPort): Promise<AuditEntry> {
  const decoded = decodeAuditEntry({ ...input, id: randomId(), at: now })
  if (!decoded.ok) throw new TypeError(`Audit entry refused: ${decoded.error}`)
  const entry = decoded.value
  let count: number
  try {
    count = storeInteger(await authorizedScript(store, await accountGuards({ store, accountAuthority }, account), AUDIT_APPEND_SCRIPT,
      [everywhereKeys.audit(account)], [entry.at, JSON.stringify(entry), now - KEEP_MS.audit, AUDIT_MAX_ENTRIES, KEEP_MS.audit]))
  } catch (error) {
    // Deletion never recreates a closed owner's audit. Unavailable upstream authority cannot authorize new data.
    if (error instanceof ApiError && ["EVERYWHERE_AUTHORITY_CHANGED", "EVERYWHERE_ACCOUNT_UNVERIFIED"].includes(error.code)) return entry
    throw error
  }
  if (count < 1 || count > AUDIT_MAX_ENTRIES) throw storeUnavailable()
  return entry
}

/** The newest entries first, at most `limit`. Entries that no longer decode are left out. */
export async function readAudit(store: Store, account: string, limit = 100): Promise<AuditEntry[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUDIT_MAX_ENTRIES) throw new RangeError("Pick 1 to 1,000.")
  const raw = await store(["ZREVRANGE", everywhereKeys.audit(account), 0, limit - 1])
  if (!Array.isArray(raw)) throw storeUnavailable()
  const entries: AuditEntry[] = []
  for (const member of raw) {
    if (typeof member !== "string") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(member)
    } catch {
      continue
    }
    const decoded = decodeAuditEntry(parsed)
    if (decoded.ok) entries.push(decoded.value)
  }
  return entries
}
