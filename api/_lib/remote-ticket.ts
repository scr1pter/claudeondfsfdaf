import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto"
import { CodiumRunTrigger } from "../../packages/schema/src/codium-run-trigger.js"
import type { EntitlementSnapshot } from "../../packages/schema/src/codium-entitlements.js"
import type { PlanId } from "../../packages/schema/src/codium-plan.js"
import { requireAccountUser } from "./account.js"
import { readEntitlement, requireEntitlement, requireUsableSnapshot } from "./codium-entitlements.js"
import { REMOTE_LIMITS } from "./codium-limits.js"
import { readSwitch } from "./codium-switches.js"
import { requireUnrevokedCliToken, requireUnrevokedAccount } from "./revocation.js"
import { ApiError, type ApiRequest } from "./http.js"
import {
  RELAY_DEVICE_ID,
  RELAY_SUBPROTOCOL,
  relayAddress,
  relayConfigured,
  relayDevices,
  type RelayDevice,
} from "./remote-relay.js"
import { phoneAppOrigin } from "./web-push.js"

/*
 * Vector Remote's API (WP A40): who may connect to the relay, and the tickets that let them (contract §4.4, §4.10, S1,
 * S3, S6). The relay (A39, packages/relay/src/ticket.ts) admits a connection on a ticket alone, so every rule about
 * plans, sign-ins and switches is decided here, from the entitlement snapshot, before a ticket is signed:
 *
 * - A computer connects with the desktop app's own sign-in: a `vct_` token marked `desktop`, checked against the
 *   account and token revocation lists. A pasted CLI token gets 403 `DESKTOP_SIGN_IN_REQUIRED`; a run token (`vrt_`,
 *   `vht_`) is never accepted (S3).
 * - A phone connects with a Vector website session (Supabase) sent from the phone app's origin,
 *   VECTOR_PHONE_APP_ORIGIN, and an account that is not revoked.
 * - Either needs Remote configured (VECTOR_REMOTE_ENABLED, the relay's address, the ticket signing key and the internal
 *   secret) and the owner's `remote` switch on (503 `REMOTE_UNAVAILABLE`), and a plan that includes Remote in a state
 *   that allows it: active, or renewing within grace (§4.4's Remote relay row). Paused, ended, frozen and no plan get
 *   the plan's own refusal (402 or 403); a plan without paired computers gets 403 `CODIUM_PERK_REQUIRED`.
 *
 * A ticket's paired-computer count, viewer-hours, meter epoch and period come from the snapshot and §4.2, never from
 * the request, so a patched client cannot widen anything (S1). The relay enforces the caps on every connection.
 */

export type RemoteRole = "computer" | "phone"
/** The claims the relay checks (packages/relay/src/ticket.ts `TicketClaims`). */
export type RelayTicketClaims = {
  v: 1
  aud: "vector-relay"
  sub: string
  role: RemoteRole
  dev: string
  name?: string
  key?: string
  computers: number
  viewerHours: number
  epoch: string
  periodEnd: number
  iat: number
  exp: number
  jti: string
}
export type RemoteTicketRequest = { role: RemoteRole; device: string; name?: string; key?: string }
export type RemoteTicket = { ticket: string; url: string; protocol: typeof RELAY_SUBPROTOCOL; expiresAt: number }
export type RemoteCaller = { account: string; via: "desktop" | "session"; origin?: string }

const TICKET_PREFIX = "vt1"
const SIGNING_CONTEXT = "vector-relay-ticket-v1."
const EPOCH_CONTEXT = "vector-relay-epoch-v1\n"
/** A ticket lives five minutes, the longest the relay accepts; a connected phone refreshes it in-band before then. */
export const TICKET_SECONDS = 300
/** The relay's ceiling on a ticket's paired computers (its RELAY_LIMITS.maxComputers). */
const RELAY_MAX_COMPUTERS = 5
const PUBLIC_KEY = /^[A-Za-z0-9_-]{32,128}$/
// Control characters (the relay's own rule), plus line separators and bidirectional overrides, which could make one
// device's name in Settings read as something else.
const NAME_REFUSED = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/

function unavailable() {
  return new ApiError(503, "REMOTE_UNAVAILABLE", "Vector Remote is temporarily unavailable.")
}

// ── Configuration ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether the owner turned Remote on for this deployment (VECTOR_REMOTE_ENABLED=true). */
export function remoteEnabled() {
  return process.env.VECTOR_REMOTE_ENABLED?.trim() === "true"
}

let signingCache: { setting: string; key: KeyObject | undefined } | undefined

/**
 * The Ed25519 private key tickets are signed with: VECTOR_REMOTE_TICKET_SIGNING_KEY, base64url PKCS#8 DER (the owner
 * makes it with the command in owner-actions/remote.md). Undefined when it is missing or is not an Ed25519 key.
 */
export function ticketSigningKey(): KeyObject | undefined {
  const setting = process.env.VECTOR_REMOTE_TICKET_SIGNING_KEY?.trim() ?? ""
  if (signingCache?.setting === setting) return signingCache.key
  let key: KeyObject | undefined
  if (setting && /^[A-Za-z0-9_-]+$/.test(setting)) {
    try {
      const parsed = createPrivateKey({ key: Buffer.from(setting, "base64url"), format: "der", type: "pkcs8" })
      key = parsed.asymmetricKeyType === "ed25519" ? parsed : undefined
    } catch {
      key = undefined
    }
  }
  signingCache = { setting, key }
  return key
}

/** Whether tickets can be minted here: Remote turned on, the relay's address, the signing key and the internal secret. */
export function remoteConfigured() {
  return remoteEnabled() && relayConfigured() && ticketSigningKey() !== undefined
}

/** Refuses with 503 while Remote is not configured or the owner's `remote` switch is off. */
export async function requireRemoteService(fetcher: typeof fetch = fetch, now = Date.now()) {
  if (!remoteConfigured() || (await readSwitch("remote", fetcher, { now })) !== "on") throw unavailable()
}

/** The plan's snapshot when it allows Remote now (§4.4), or the plan's refusal. Reads only the snapshot (M4). */
export function requireRemotePlan(account: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  return requireEntitlement(account, "remote", fetcher, now)
}

// ── Callers ────────────────────────────────────────────────────────────────────────────────────────────────────────

function header(request: Pick<ApiRequest, "headers">, name: string) {
  const value = request.headers[name]
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

function origin(request: Pick<ApiRequest, "headers">) {
  const value = header(request, "origin")
  if (!value) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/**
 * The account behind a Remote request: the desktop app's own sign-in (`via: "desktop"`) or a website session
 * (`via: "session"`, with the request's origin). Run tokens and anything that is not a bearer credential get 401
 * before any lookup, so a run token never reaches the account service. A revoked account is refused either way.
 */
export async function requireRemoteCaller(
  request: Pick<ApiRequest, "headers">,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RemoteCaller> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(header(request, "authorization"))?.[1]
  if (!bearer || bearer.length > 8192 || bearer.startsWith("vrt_") || bearer.startsWith("vht_"))
    throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in to Vector to use Vector Remote.")
  if (bearer.startsWith("vct_")) {
    const claims = await requireUnrevokedCliToken(bearer, fetcher, now)
    if (claims.client !== "desktop")
      throw new ApiError(403, "DESKTOP_SIGN_IN_REQUIRED", "Sign in to Vector again in the app to use Vector Remote.")
    return { account: claims.id, via: "desktop" }
  }
  const user = await requireAccountUser(request, fetcher)
  await requireUnrevokedAccount(user.id, fetcher)
  const from = origin(request)
  return { account: user.id, via: "session", ...(from ? { origin: from } : {}) }
}

/**
 * The role check of a ticket: a computer only with the desktop sign-in, a phone only with a session sent from the
 * phone app's own origin (the phone app calls its API on that origin, so the browser sets `Origin` to it).
 */
export function requireRoleCaller(caller: RemoteCaller, role: RemoteRole) {
  if (role === "computer") {
    if (caller.via !== "desktop")
      throw new ApiError(403, "DESKTOP_SIGN_IN_REQUIRED", "Connect a computer from the Vector app, signed in.")
    return
  }
  const phone = phoneAppOrigin()
  if (!phone) throw unavailable()
  if (caller.via !== "session" || caller.origin !== phone)
    throw new ApiError(403, "REMOTE_PHONE_APP_REQUIRED", "Open Vector Remote on your phone to connect it.")
}

// ── Tickets ────────────────────────────────────────────────────────────────────────────────────────────────────────

function invalidTicket() {
  return new ApiError(400, "REMOTE_TICKET_INVALID", "Check the device details and try again.")
}

/**
 * The body of `POST /api/remote/ticket`: `{role, device, name?, key?}`. `device` is the 16-byte id the device made
 * for itself (base64url); `name` is what Settings shows; `key` is its public key for pairing, which the relay lists.
 * Anything else in the body is ignored, in particular any count, plan or period: those come from the snapshot.
 */
export function parseTicketRequest(input: unknown): RemoteTicketRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidTicket()
  const body = input as Record<string, unknown>
  if (body.role !== "computer" && body.role !== "phone") throw invalidTicket()
  if (typeof body.device !== "string" || !RELAY_DEVICE_ID.test(body.device)) throw invalidTicket()
  let name: string | undefined
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== "string") throw invalidTicket()
    name = body.name.trim()
    if (!name || name.length > 64 || NAME_REFUSED.test(name)) throw invalidTicket()
  }
  if (body.key !== undefined && body.key !== null && (typeof body.key !== "string" || !PUBLIC_KEY.test(body.key)))
    throw invalidTicket()
  return {
    role: body.role,
    device: body.device,
    ...(name ? { name } : {}),
    ...(typeof body.key === "string" ? { key: body.key } : {}),
  }
}

/**
 * The relay's meter epoch for a period: a hash of the snapshot's `meterEpoch` (`<subscription>:<periodStart>`), so no
 * Stripe id reaches the relay and every new period, an upgrade's included, starts its time meters at zero.
 */
export function relayEpoch(meterEpoch: string) {
  return createHash("sha256").update(EPOCH_CONTEXT).update(meterEpoch).digest("base64url")
}

/** The claims for one connection, from the snapshot and §4.2 alone (plus the device's own id, name and key). */
export function ticketClaims(
  snapshot: EntitlementSnapshot,
  request: RemoteTicketRequest,
  now = Date.now(),
  jti = randomBytes(16).toString("base64url"),
): RelayTicketClaims {
  const plan = snapshot.plan as PlanId | null
  const computers = snapshot.caps.remote.computers
  const viewerHours = plan ? REMOTE_LIMITS.viewerHours[plan] : undefined
  if (
    !plan ||
    !Number.isSafeInteger(computers) ||
    computers < 1 ||
    computers > RELAY_MAX_COMPUTERS ||
    !viewerHours ||
    !snapshot.meterEpoch ||
    snapshot.meterEpoch === "none" ||
    !Number.isSafeInteger(snapshot.periodEnd) ||
    snapshot.periodEnd < 1
  )
    throw unavailable()
  const iat = Math.floor(now / 1000)
  return {
    v: 1,
    aud: "vector-relay",
    sub: snapshot.account,
    role: request.role,
    dev: request.device,
    ...(request.name ? { name: request.name } : {}),
    ...(request.key ? { key: request.key } : {}),
    computers,
    viewerHours,
    epoch: relayEpoch(snapshot.meterEpoch),
    periodEnd: snapshot.periodEnd,
    iat,
    exp: iat + TICKET_SECONDS,
    jti,
  }
}

/** `vt1.<payload>.<signature>`: Ed25519 over "vector-relay-ticket-v1." and the base64url JSON payload. */
export function signRelayTicket(claims: RelayTicketClaims, key: KeyObject) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  const signature = sign(null, Buffer.from(SIGNING_CONTEXT + payload), key).toString("base64url")
  return `${TICKET_PREFIX}.${payload}.${signature}`
}

/**
 * One ticket for a caller already checked by `requireRemoteCaller` and `requireRoleCaller`: Remote on, the plan
 * allowing it, then the signed claims and where to connect.
 */
export async function mintRemoteTicket(
  caller: RemoteCaller,
  request: RemoteTicketRequest,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RemoteTicket> {
  await requireRemoteService(fetcher, now)
  const snapshot = await requireRemotePlan(caller.account, fetcher, now)
  const key = ticketSigningKey()
  const address = relayAddress()
  if (!key || !address) throw unavailable()
  const claims = ticketClaims(snapshot, request, now)
  return {
    ticket: signRelayTicket(claims, key),
    url: address.socket,
    protocol: RELAY_SUBPROTOCOL,
    expiresAt: claims.exp * 1000,
  }
}

// ── Devices ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type RemoteDevices = {
  devices: RelayDevice[]
  limits: { computers: number; phones: number }
  fairUse: "ok" | "viewer" | "awake"
  /** Whether this account can connect devices now: Remote on and a plan that allows it. */
  available: boolean
}

/**
 * The account's paired devices for Settings and the phone's Devices page. Listing works whatever the plan, so a device
 * can always be found and revoked; an account that never had a plan has nothing at the relay, so it is not asked.
 * The computer limit is the plan's while the plan allows Remote, else 0; `overLimit` marks the devices past it in
 * pairing order, which the relay refuses.
 */
export async function remoteDevices(
  account: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RemoteDevices> {
  if (!relayConfigured()) throw unavailable()
  const snapshot = await readEntitlement(account, fetcher, now)
  if (!snapshot || snapshot.state === "none")
    return { devices: [], limits: { computers: 0, phones: REMOTE_LIMITS.phones }, fairUse: "ok", available: false }
  let usable: EntitlementSnapshot | undefined
  try {
    usable = requireUsableSnapshot(snapshot, now)
  } catch {
    usable = undefined
  }
  const computers = usable ? usable.caps.remote.computers : 0
  const limits = { computers, phones: REMOTE_LIMITS.phones }
  const available =
    computers > 0 && remoteConfigured() && (await readSwitch("remote", fetcher, { now }).catch(() => "off")) === "on"
  const relay = await relayDevices(account, fetcher, now)
  const seen = { computer: 0, phone: 0 }
  const devices = relay.devices.map((device) => {
    const index = seen[device.role]++
    return { ...device, overLimit: index >= (device.role === "computer" ? limits.computers : limits.phones) }
  })
  return { devices, limits, fairUse: relay.fairUse, available }
}

// ── GitHub runs for the phone (Codex's run records) ───────────────────────────────────────────────────────────────

/**
 * Reads an account's newest runs of Vector's GitHub agent. Codex's `listCloudRuns(account, {limit})`
 * (api/_lib/cloud-agents-runs.ts on vector-at-mention) is this shape; the integration commit (A59) registers it, as
 * this build never imports Codex's files. Until then the list is empty and says so.
 */
export type CloudRunReader = (account: string, input: { limit: number }) => Promise<readonly unknown[]>
let cloudRuns: CloudRunReader | undefined

export function registerCloudRunReader(reader: CloudRunReader) {
  if (typeof reader !== "function" || cloudRuns) throw new Error("Remote's GitHub run list has exactly one reader.")
  cloudRuns = reader
}

export function cloudRunReader() {
  return cloudRuns
}

export type RemoteCloudRun = {
  id: string
  repository?: string
  url?: string
  event: string
  source: CodiumRunTrigger.RunSource
  purpose: string
  startedAt: number
  endedAt?: number
  outcome?: string
  verdict?: "pass" | "fail" | "none"
  actor?: { login: string }
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/
const WORD = /^[a-z][a-z0-9_-]{0,39}$/
const LOGIN = /^(?:[A-Za-z0-9][A-Za-z0-9-]{0,38}|[a-z0-9][a-z0-9-]{0,98}\[bot\])$/

/**
 * One run as the phone may show it, or undefined when a field is malformed. Only these fields pass: what ran, where,
 * when and how it ended. Nothing about usage, plans or Codium spend is in a run record, and nothing else is copied (P1,
 * P6).
 */
export function publicCloudRun(input: unknown): RemoteCloudRun | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const run = input as Record<string, unknown>
  const time = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0
  if (typeof run.rid !== "string" || !RUN_ID.test(run.rid)) return undefined
  if (typeof run.event !== "string" || !WORD.test(run.event)) return undefined
  if (!CodiumRunTrigger.ENABLED_SOURCES.has(run.source as CodiumRunTrigger.RunSource)) return undefined
  if (typeof run.purpose !== "string" || !WORD.test(run.purpose)) return undefined
  if (!time(run.startedAt) || (run.endedAt !== undefined && !time(run.endedAt))) return undefined
  const repository = typeof run.repository === "string" && REPOSITORY.test(run.repository) ? run.repository : undefined
  const url =
    typeof run.runUrl === "string" &&
    run.runUrl.length <= 300 &&
    /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}\/actions\/runs\/\d{1,20}$/.test(
      run.runUrl,
    )
      ? run.runUrl
      : undefined
  const actor =
    run.actor && typeof run.actor === "object" && !Array.isArray(run.actor)
      ? (run.actor as Record<string, unknown>).login
      : undefined
  return {
    id: run.rid,
    ...(repository ? { repository } : {}),
    ...(url ? { url } : {}),
    event: run.event,
    source: run.source as CodiumRunTrigger.RunSource,
    purpose: run.purpose,
    startedAt: run.startedAt as number,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt as number } : {}),
    ...(typeof run.outcome === "string" && WORD.test(run.outcome) ? { outcome: run.outcome } : {}),
    ...(run.verdict === "pass" || run.verdict === "fail" || run.verdict === "none" ? { verdict: run.verdict } : {}),
    ...(typeof actor === "string" && LOGIN.test(actor) ? { actor: { login: actor } } : {}),
  }
}

/**
 * The account's newest GitHub runs for the phone, on every paid plan that includes Remote (all of them): Remote on,
 * the plan allowing it (§4.4), then the reader's records, newest first. `available: false` while no reader is
 * registered (before A59).
 */
export async function remoteCloudRuns(
  account: string,
  limit: number,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  reader: CloudRunReader | undefined = cloudRuns,
): Promise<{ runs: RemoteCloudRun[]; available: boolean }> {
  await requireRemoteService(fetcher, now)
  await requireRemotePlan(account, fetcher, now)
  if (!reader) return { runs: [], available: false }
  let records: readonly unknown[]
  try {
    records = await reader(account, { limit })
  } catch {
    throw new ApiError(503, "REMOTE_RUNS_UNAVAILABLE", "Your GitHub runs could not be read. Try again in a moment.")
  }
  if (!Array.isArray(records)) throw unavailable()
  return {
    runs: records.slice(0, limit).flatMap((record) => {
      const run = publicCloudRun(record)
      return run ? [run] : []
    }),
    available: true,
  }
}
