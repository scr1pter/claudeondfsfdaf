// One Durable Object per account (WP A39), named by HMAC(ACCOUNT_KEY, account) so it never holds the account id. It
// relays end-to-end ciphertext between the account's paired computers and phones over hibernating WebSockets, keeps
// the paired devices and the time meters in its SQLite storage, and applies the plan's caps from the newest ticket.
//
// Costs stay near the typical figure because the object sleeps whenever nothing happens: heartbeats are answered by
// the runtime (setWebSocketAutoResponse) without waking it, the alarm runs only while a viewer is attached, a computer
// that streams with no viewer is closed, and the time meters are written at most once a minute while viewers stay.

import { base64url, fromBase64url } from "./bytes"
import { INTERNAL_NONCE_KEEP_MS } from "./internal"
import { RELAY_LIMITS } from "./limits"
import {
  CLOSE,
  CLOSE_REASON,
  FRAME,
  FRAME_HEADER_BYTES,
  HEARTBEAT,
  RELAY_SUBPROTOCOL,
  isDeviceId,
  type CloseCode,
  type DeviceRole,
  type NoticeCode,
  type Peer,
  type ServerMessage,
} from "./protocol"
import {
  workersRuntime,
  type DurableObjectState,
  type Env,
  type RelaySocket,
  type Runtime,
  type SqlValue,
} from "./runtime"
import { accountHandle, importTicketKeys, verifyTicket, type TicketClaims } from "./ticket"

/** The verified ticket travels from the Worker to the object in this header (the object checks it again). */
export const TICKET_HEADER = "x-vector-relay-ticket"
/** The internal request's nonce, which the object records so a signed request is applied once. */
export const NONCE_HEADER = "x-vector-relay-nonce"
/** REMOTE_FLAGS key whose value "1" turns the relay off. */
export const KILL_KEY = "kill"
/** Meters of a period are kept this long past its end (as the API's meters are). */
export const METER_KEEP_MS = 40 * 24 * 60 * 60_000

export const INTERNAL_ACTIONS = ["kill", "suspend", "presence", "devices", "revoke-device", "erase", "flags"] as const
export type InternalAction = (typeof INTERNAL_ACTIONS)[number]

type Attachment = { v: 1; role: DeviceRole; dev: string; iat: number; exp: number; at: number; active: number }
type Plan = { epoch: string; periodEnd: number; computers: number; viewerHours: number; iat: number }
type Suspension = { reason: SuspendReason; at: number }
type SuspendReason = "paused" | "frozen" | "owner"
type DeviceRow = {
  id: string
  role: string
  name: string | null
  public_key: string | null
  paired_at: number
  last_seen: number
  revoked_at: number | null
}
export type FairUse = "ok" | "viewer" | "awake"
type Bucket = { tokens: number; at: number; refused: number; since: number }

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT, public_key TEXT, paired_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, revoked_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS meters (epoch TEXT NOT NULL, name TEXT NOT NULL, ms INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (epoch, name))",
  "CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS seen_expiry ON seen (expires_at)",
]
const SUSPEND_REASONS: readonly SuspendReason[] = ["paused", "frozen", "owner"]
const NONCE = /^[A-Za-z0-9_-]{22,64}$/

export class AccountRelay {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private readonly runtime: Runtime
  private plan: Plan | undefined
  private flushedAt: number
  /** Awake time not yet written: the union of [event, event + idleTailMs] since the last write, in memory. */
  private awakePending = 0
  private lastEventAt: number | undefined
  private fairCheckedAt: number | undefined
  private readonly heard = new WeakMap<RelaySocket, number>()
  private readonly active = new WeakMap<RelaySocket, number>()
  private readonly buckets = new WeakMap<RelaySocket, Bucket>()
  private readonly noticed = new WeakMap<RelaySocket, number>()
  private readonly orphans = new WeakMap<RelaySocket, number[]>()
  private readonly closing = new WeakSet<RelaySocket>()
  private readonly ids = new Map<string, Uint8Array>()
  private announced: Partial<Record<DeviceRole, string>> = {}

  constructor(ctx: DurableObjectState, env: Env, runtime: Runtime = workersRuntime()) {
    this.ctx = ctx
    this.env = env
    this.runtime = runtime
    this.migrate()
    ctx.setWebSocketAutoResponse(runtime.autoResponse(HEARTBEAT.request, HEARTBEAT.response))
    this.plan = this.meta<Plan>("plan")
    this.flushedAt = this.meta<number>("flushed_at") ?? 0
  }

  async fetch(request: Request): Promise<Response> {
    const now = this.runtime.now()
    this.touch(now)
    try {
      const path = new URL(request.url).pathname
      if (path === "/connect") return await this.connect(request, now)
      const action = /^\/internal\/([a-z-]{1,32})$/.exec(path)?.[1]
      if (action && request.method === "POST") return await this.internal(action, request, now)
      return failure(404, "RELAY_NOT_FOUND")
    } finally {
      this.maybeFlush(now)
    }
  }

  async webSocketMessage(socket: RelaySocket, message: string | ArrayBuffer): Promise<void> {
    const now = this.runtime.now()
    this.touch(now)
    try {
      const attachment = this.attachment(socket)
      if (!attachment || this.closing.has(socket)) return
      this.heard.set(socket, now)
      if (typeof message === "string") await this.control(socket, attachment, message, now)
      else await this.data(socket, attachment, new Uint8Array(message), now)
      // Messages keep the object awake with no alarm running (a computer with no viewer), so fair use is checked here
      // too, at most every few seconds.
      if (this.fairCheckedAt === undefined || now - this.fairCheckedAt >= RELAY_LIMITS.fairCheckEveryMs) {
        this.fairCheckedAt = now
        if (this.dropForFairUse(now)) await this.settle(now)
      }
    } finally {
      this.maybeFlush(now)
    }
  }

  async webSocketClose(socket: RelaySocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await this.gone(socket)
  }

  async webSocketError(socket: RelaySocket, _error: unknown): Promise<void> {
    await this.gone(socket)
  }

  /** Armed only while a viewer is attached: kill flag, idle and stale connections, fair use, and the minute's meters. */
  async alarm(): Promise<void> {
    const now = this.runtime.now()
    this.touch(now)
    try {
      if (await this.killed()) {
        for (const socket of this.live()) this.drop(socket, CLOSE.RELAY_OFF)
        await this.settle(now)
        return
      }
      this.sweep(now)
      this.dropForFairUse(now)
      await this.settle(now)
      if (this.live("phone").length) await this.ctx.storage.setAlarm(now + RELAY_LIMITS.alarmEveryMs)
    } finally {
      this.maybeFlush(now)
    }
  }

  // Connections

  private async connect(request: Request, now: number): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return failure(426, "RELAY_UPGRADE_REQUIRED")
    const claims = await this.verify(request.headers.get(TICKET_HEADER) ?? "", now)
    if (!claims) return failure(401, "RELAY_TICKET_INVALID")
    const handle = await accountHandle(this.env.ACCOUNT_KEY, claims.sub)
    if (!handle) return failure(503, "RELAY_UNAVAILABLE")
    const known = this.meta<string>("account")
    if (known !== undefined && known !== handle) return failure(409, "RELAY_MISROUTED")
    if (known === undefined) this.setMeta("account", handle)
    if (!this.once(`t:${claims.jti}`, (claims.exp + RELAY_LIMITS.ticketSkewSeconds) * 1000, now))
      return failure(401, "RELAY_TICKET_USED")
    this.sweep(now)
    let refusal = this.standing(claims)
    if (refusal === undefined) {
      this.applyPlan(claims, now)
      refusal = this.admission(claims, now)
    }
    const { client, server } = this.runtime.pair()
    const headers = { "sec-websocket-protocol": RELAY_SUBPROTOCOL }
    if (refusal !== undefined) {
      // The refusal is a close code, which a browser can read; an HTTP status it cannot.
      server.accept?.()
      server.close(refusal, CLOSE_REASON[refusal])
      await this.settle(now)
      return this.runtime.upgrade(client, headers)
    }
    this.register(claims, now)
    this.ctx.acceptWebSocket(server, [claims.role, `dev:${claims.dev}`])
    server.serializeAttachment({
      v: 1,
      role: claims.role,
      dev: claims.dev,
      iat: claims.iat,
      exp: claims.exp,
      at: now,
      active: now,
    } satisfies Attachment)
    this.heard.set(server, now)
    this.active.set(server, now)
    // One connection per device: a newer one replaces the older.
    for (const socket of this.live(`dev:${claims.dev}`)) if (socket !== server) this.drop(socket, CLOSE.REPLACED)
    this.send(server, {
      t: "hello",
      v: 1,
      role: claims.role,
      device: claims.dev,
      exp: claims.exp,
      peers: this.peers(opposite(claims.role)),
      viewers: this.live("phone").length,
    })
    await this.settle(now)
    return this.runtime.upgrade(client, headers)
  }

  /** Refusals that do not depend on the plan: suspension, revocation, a revoked device, a device changing role. */
  private standing(claims: TicketClaims): CloseCode | undefined {
    if (this.meta<Suspension>("suspended")) return CLOSE.REMOTE_PAUSED
    if (claims.iat * 1000 < (this.meta<number>("revoked_before") ?? 0)) return CLOSE.REMOTE_REVOKED
    const device = this.device(claims.dev)
    if (device?.revoked_at !== null && device?.revoked_at !== undefined) return CLOSE.REMOTE_REVOKED
    if (device && device.role !== claims.role) return CLOSE.PROTOCOL
    return undefined
  }

  /** Fair use, then the device caps: the plan's computers and §4.2's phones, counted in pairing order. */
  private admission(claims: TicketClaims, now: number): CloseCode | undefined {
    const fair = this.fairUse(now)
    if (fair === "awake" || (fair === "viewer" && claims.role === "phone")) return CLOSE.REMOTE_FAIR_USE
    const limit = this.limit(claims.role)
    const order = this.activeDevices(claims.role).map((device) => device.id)
    const index = order.indexOf(claims.dev)
    if (index === -1 ? order.length >= limit : index >= limit) return CLOSE.REMOTE_DEVICE_LIMIT
    return undefined
  }

  private limit(role: DeviceRole) {
    const computers = this.plan?.computers ?? 0
    if (role === "computer") return computers
    return computers > 0 ? RELAY_LIMITS.phones : 0
  }

  /**
   * The plan's caps and meter epoch come from the newest ticket (by issue time). A new epoch starts the time meters
   * over (time already spent is written to the old one first); a lower computer count closes the computers paired
   * after it.
   */
  private applyPlan(claims: TicketClaims, now: number) {
    const current = this.plan
    // A ticket issued before the one that set the current plan never undoes it (a phone holding a ticket from before
    // an upgrade, say). The stored iat is that ticket's, so it is written only when the plan changes.
    if (current && claims.iat < current.iat) return
    if (
      current &&
      current.epoch === claims.epoch &&
      current.periodEnd === claims.periodEnd &&
      current.computers === claims.computers &&
      current.viewerHours === claims.viewerHours
    )
      return
    const next: Plan = {
      epoch: claims.epoch,
      periodEnd: claims.periodEnd,
      computers: claims.computers,
      viewerHours: claims.viewerHours,
      iat: claims.iat,
    }
    if (current && current.epoch !== next.epoch) {
      this.flush(now)
      this.sql("DELETE FROM meters WHERE expires_at < ?", now)
    }
    this.plan = next
    this.setMeta("plan", next)
    if (current && next.computers < current.computers) this.enforceDeviceLimits()
  }

  private enforceDeviceLimits() {
    for (const role of ["computer", "phone"] as const) {
      const over = new Set(
        this.activeDevices(role)
          .slice(this.limit(role))
          .map((device) => device.id),
      )
      for (const socket of this.live(role)) {
        const attachment = this.attachment(socket)
        if (attachment && over.has(attachment.dev)) this.drop(socket, CLOSE.REMOTE_DEVICE_LIMIT)
      }
    }
  }

  private register(claims: TicketClaims, now: number) {
    this.sql(
      "INSERT INTO devices (id, role, name, public_key, paired_at, last_seen) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET name = coalesce(excluded.name, devices.name), " +
        "public_key = coalesce(excluded.public_key, devices.public_key), last_seen = excluded.last_seen",
      claims.dev,
      claims.role,
      claims.name ?? null,
      claims.key ?? null,
      now,
      now,
    )
  }

  private async gone(socket: RelaySocket) {
    const now = this.runtime.now()
    this.touch(now)
    try {
      const attachment = this.attachment(socket)
      this.closing.add(socket)
      try {
        // Completes the closing handshake the runtime leaves to the object; a socket already closed ignores it.
        socket.close(1000, "closed")
      } catch {
        // Already closed.
      }
      if (attachment) this.sql("UPDATE devices SET last_seen = ? WHERE id = ?", now, attachment.dev)
      await this.settle(now)
      // The object may sleep for good now, so what the meters hold is written.
      if (!this.live().length) this.flush(now)
    } finally {
      this.maybeFlush(now)
    }
  }

  // Messages

  private async control(socket: RelaySocket, attachment: Attachment, text: string, now: number) {
    if (text.length > RELAY_LIMITS.controlBytes) return this.dropAndSettle(socket, CLOSE.TOO_LARGE, now)
    const allowed = this.allow(socket, now)
    if (allowed === "close") return this.dropAndSettle(socket, CLOSE.TOO_FAST, now)
    if (allowed === "refused") return
    // Control messages are not activity: a phone app refreshes its ticket on its own, so only data counts as a viewer
    // doing something.
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return this.notice(socket, "bad-frame", now)
    }
    const fields =
      message && typeof message === "object" && !Array.isArray(message) ? (message as Record<string, unknown>) : {}
    if (fields.t === "refresh") return this.refresh(socket, attachment, fields.ticket, now)
    if (fields.t === "presence")
      return this.send(socket, {
        t: "peers",
        peers: this.peers(opposite(attachment.role)),
        viewers: this.live("phone").length,
      })
    // §4.17 reserves job.offer for the server; a client may not send it.
    if (fields.t === "job.offer") return this.notice(socket, "reserved", now)
    return this.notice(socket, "unknown", now)
  }

  private async refresh(socket: RelaySocket, attachment: Attachment, ticket: unknown, now: number) {
    const claims = typeof ticket === "string" ? await this.verify(ticket, now) : undefined
    if (
      !claims ||
      claims.role !== attachment.role ||
      claims.dev !== attachment.dev ||
      (await accountHandle(this.env.ACCOUNT_KEY, claims.sub)) !== this.meta<string>("account") ||
      !this.once(`t:${claims.jti}`, (claims.exp + RELAY_LIMITS.ticketSkewSeconds) * 1000, now)
    )
      return this.notice(socket, "ticket-invalid", now)
    if (await this.killed()) return this.dropAndSettle(socket, CLOSE.RELAY_OFF, now)
    const refusal = this.standing(claims)
    if (refusal !== undefined) return this.dropAndSettle(socket, refusal, now)
    this.applyPlan(claims, now)
    attachment.iat = claims.iat
    attachment.exp = claims.exp
    socket.serializeAttachment(attachment)
    this.register(claims, now)
    this.send(socket, { t: "refreshed", exp: claims.exp })
    await this.settle(now)
  }

  private async data(socket: RelaySocket, attachment: Attachment, frame: Uint8Array, now: number) {
    if (frame.byteLength > RELAY_LIMITS.frameBytes) return this.dropAndSettle(socket, CLOSE.TOO_LARGE, now)
    const allowed = this.allow(socket, now)
    if (allowed === "close") return this.dropAndSettle(socket, CLOSE.TOO_FAST, now)
    if (allowed === "refused") return
    if (attachment.role === "phone") this.markActive(socket, attachment, now)
    if (now >= attachment.exp * 1000) return this.notice(socket, "ticket-expired", now)
    if (frame.byteLength < FRAME_HEADER_BYTES) return this.notice(socket, "bad-frame", now)
    if (frame[0] === FRAME.JOB_OFFER) return this.notice(socket, "reserved", now)
    if (frame[0] !== FRAME.DATA) return this.notice(socket, "bad-frame", now)
    // With no viewer there is nobody to send to; a computer that keeps trying is closed.
    if (attachment.role === "computer" && !this.live("phone").length) return this.orphan(socket, now)
    const target = base64url(frame.subarray(1, FRAME_HEADER_BYTES))
    const role = opposite(attachment.role)
    const peer = this.live(`dev:${target}`).find((candidate) => this.attachment(candidate)?.role === role)
    if (!peer) return this.notice(socket, "no-peer", now)
    // The ciphertext goes on byte for byte; only the header's device changes from the target to the sender.
    const out = frame.slice()
    out.set(this.idBytes(attachment.dev), 1)
    this.send(peer, out)
  }

  private async orphan(socket: RelaySocket, now: number) {
    const recent = (this.orphans.get(socket) ?? []).filter((at) => now - at < RELAY_LIMITS.noViewerWindowMs)
    recent.push(now)
    this.orphans.set(socket, recent)
    if (recent.length >= RELAY_LIMITS.noViewerFrames) return this.dropAndSettle(socket, CLOSE.NO_VIEWER, now)
    this.notice(socket, "no-viewer", now)
  }

  /** Frames a second per connection: a bucket of 40 refilled at 20 a second. Sustained refusals close it. */
  private allow(socket: RelaySocket, now: number): "ok" | "refused" | "close" {
    const bucket = this.buckets.get(socket) ?? { tokens: RELAY_LIMITS.burstFrames, at: now, refused: 0, since: now }
    bucket.tokens = Math.min(
      RELAY_LIMITS.burstFrames,
      bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * RELAY_LIMITS.framesPerSecond,
    )
    bucket.at = now
    this.buckets.set(socket, bucket)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return "ok"
    }
    if (now - bucket.since > RELAY_LIMITS.tooFastWindowMs) {
      bucket.since = now
      bucket.refused = 0
    }
    bucket.refused += 1
    if (bucket.refused > RELAY_LIMITS.tooFastRefusals) return "close"
    this.notice(socket, "too-fast", now)
    return "refused"
  }

  /** A viewer's last activity: in memory always, in its attachment at most once a minute. */
  private markActive(socket: RelaySocket, attachment: Attachment, now: number) {
    this.active.set(socket, now)
    if (now - attachment.active >= RELAY_LIMITS.flushEveryMs) {
      attachment.active = now
      socket.serializeAttachment(attachment)
    }
  }

  private notice(socket: RelaySocket, code: NoticeCode, now: number) {
    const last = this.noticed.get(socket)
    if (last !== undefined && now - last < RELAY_LIMITS.noticeEveryMs) return
    this.noticed.set(socket, now)
    this.send(socket, { t: "error", code })
  }

  private send(socket: RelaySocket, message: ServerMessage | Uint8Array) {
    try {
      socket.send(message instanceof Uint8Array ? message : JSON.stringify(message))
    } catch {
      // A socket that closed meanwhile.
    }
  }

  // Housekeeping

  /** Closes connections that may no longer stay: suspended, revoked, silent, expired, or idle viewers. */
  private sweep(now: number) {
    const revokedBefore = this.meta<number>("revoked_before") ?? 0
    const suspended = this.meta<Suspension>("suspended") !== undefined
    for (const socket of this.live()) {
      const attachment = this.attachment(socket)
      if (!attachment) {
        this.drop(socket, CLOSE.PROTOCOL)
        continue
      }
      if (suspended) {
        this.drop(socket, CLOSE.REMOTE_PAUSED)
        continue
      }
      if (attachment.iat * 1000 < revokedBefore) {
        this.drop(socket, CLOSE.REMOTE_REVOKED)
        continue
      }
      const heard = Math.max(
        attachment.at,
        this.heard.get(socket) ?? 0,
        this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0,
      )
      if (now - heard > RELAY_LIMITS.heartbeatStaleMs) {
        this.drop(socket, CLOSE.STALE)
        continue
      }
      const expiredFor = now - attachment.exp * 1000
      if (attachment.role === "phone") {
        if (expiredFor > RELAY_LIMITS.viewerTicketGraceMs) this.drop(socket, CLOSE.TICKET_EXPIRED)
        else if (now - Math.max(attachment.active, this.active.get(socket) ?? 0) >= RELAY_LIMITS.viewerIdleMs)
          this.drop(socket, CLOSE.IDLE)
      } else if (expiredFor > RELAY_LIMITS.computerTicketMaxAgeMs) this.drop(socket, CLOSE.TICKET_EXPIRED)
    }
  }

  /** After any change of who is connected: the viewer clock and alarm, then the peer lists. */
  private async settle(now: number) {
    await this.syncViewing(now)
    this.announce("phone", now)
    this.announce("computer", now)
  }

  /**
   * Viewer time runs while at least one viewer is attached. Its start is stored when the first viewer arrives, so the
   * running total survives hibernation; the meter itself is written at most once a minute (the alarm), and once more
   * when the last viewer leaves. The alarm exists exactly while a viewer is attached.
   */
  private async syncViewing(now: number) {
    const viewers = this.live("phone").length
    const since = this.meta<number>("viewing_since")
    if (viewers > 0) {
      if (since === undefined) this.setMeta("viewing_since", now)
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + RELAY_LIMITS.alarmEveryMs)
      return
    }
    if (since !== undefined) {
      this.addMeter("viewer", now - since)
      this.deleteMeta("viewing_since")
    }
    if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm()
  }

  /** Sends one side's online devices to the other side when that list changed. */
  private announce(role: DeviceRole, now: number) {
    const peers = this.peers(role)
    const viewers = this.live("phone").length
    const key = JSON.stringify([peers, viewers])
    if (this.announced[role] === key) return
    this.announced[role] = key
    for (const socket of this.live(opposite(role))) {
      const attachment = this.attachment(socket)
      // A viewer arrived: a computer whose ticket lapsed while it was idle must refresh before it can stream.
      const refresh = attachment?.role === "computer" && viewers > 0 && now >= attachment.exp * 1000
      this.send(socket, { t: "peers", peers, viewers, ...(refresh ? { refresh: true as const } : {}) })
    }
  }

  private peers(role: DeviceRole): Peer[] {
    const rows = new Map(
      this.sql<DeviceRow>("SELECT * FROM devices WHERE role = ? AND revoked_at IS NULL", role).map((row) => [
        row.id,
        row,
      ]),
    )
    const peers = new Map<string, Peer>()
    for (const socket of this.live(role)) {
      const attachment = this.attachment(socket)
      if (!attachment || peers.has(attachment.dev)) continue
      const row = rows.get(attachment.dev)
      peers.set(attachment.dev, {
        device: attachment.dev,
        role,
        ...(row?.name ? { name: row.name } : {}),
        ...(row?.public_key ? { key: row.public_key } : {}),
      })
    }
    return [...peers.values()].sort((left, right) =>
      left.device < right.device ? -1 : left.device > right.device ? 1 : 0,
    )
  }

  // Fair use

  /** Viewer-hours used up closes the viewers; awake-hours used up closes everyone. True when something closed. */
  private dropForFairUse(now: number) {
    const fair = this.fairUse(now)
    if (fair === "ok") return false
    const sockets = this.live(fair === "awake" ? undefined : "phone")
    for (const socket of sockets) this.drop(socket, CLOSE.REMOTE_FAIR_USE)
    return sockets.length > 0
  }

  /** "viewer" once this period's viewer time reaches the plan's viewer-hours; "awake" once awake time passes 1.5×. */
  private fairUse(now: number): FairUse {
    const plan = this.plan
    if (!plan) return "ok"
    const limit = plan.viewerHours * 3_600_000
    const since = this.meta<number>("viewing_since")
    const viewer = this.meter(plan.epoch, "viewer") + (since !== undefined ? Math.max(0, now - since) : 0)
    const awake = this.meter(plan.epoch, "awake") + this.awakePending
    if (awake >= limit * RELAY_LIMITS.awakeFactor) return "awake"
    if (viewer >= limit) return "viewer"
    return "ok"
  }

  /**
   * Awake time estimates what the runtime bills: an object stays in memory about ten seconds after its last event, so
   * each event adds the gap since the previous one, up to that tail.
   */
  private touch(now: number) {
    this.awakePending +=
      this.lastEventAt === undefined
        ? RELAY_LIMITS.idleTailMs
        : Math.min(Math.max(0, now - this.lastEventAt), RELAY_LIMITS.idleTailMs)
    this.lastEventAt = now
  }

  private maybeFlush(now: number) {
    if (now - this.flushedAt >= RELAY_LIMITS.flushEveryMs) this.flush(now)
  }

  private flush(now: number) {
    this.flushedAt = now
    // No plan yet (or erased): there is nothing to meter, and nothing is written.
    if (!this.plan) return
    const since = this.meta<number>("viewing_since")
    if (since !== undefined && now > since) {
      this.addMeter("viewer", now - since)
      this.setMeta("viewing_since", now)
    }
    if (this.awakePending > 0) {
      this.addMeter("awake", this.awakePending)
      this.awakePending = 0
    }
    this.setMeta("flushed_at", now)
  }

  private meter(epoch: string, name: string) {
    return this.sql<{ ms: number }>("SELECT ms FROM meters WHERE epoch = ? AND name = ?", epoch, name)[0]?.ms ?? 0
  }

  private addMeter(name: "viewer" | "awake", ms: number) {
    const plan = this.plan
    const amount = Math.round(ms)
    if (!plan || amount <= 0) return
    this.sql(
      "INSERT INTO meters (epoch, name, ms, expires_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(epoch, name) DO UPDATE SET ms = meters.ms + excluded.ms, expires_at = excluded.expires_at",
      plan.epoch,
      name,
      amount,
      plan.periodEnd + METER_KEEP_MS,
    )
  }

  // The internal API (signed by the API; the Worker checked the signature)

  private async internal(action: string, request: Request, now: number): Promise<Response> {
    const nonce = request.headers.get(NONCE_HEADER) ?? ""
    if (!NONCE.test(nonce) || !this.once(`n:${nonce}`, now + INTERNAL_NONCE_KEEP_MS, now))
      return failure(401, "INTERNAL_SIGNATURE_INVALID")
    let body: Record<string, unknown>
    try {
      const parsed: unknown = await request.json()
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure(400, "INTERNAL_BAD_REQUEST")
      body = parsed as Record<string, unknown>
    } catch {
      return failure(400, "INTERNAL_BAD_REQUEST")
    }
    if (action === "erase") return this.erase(now)
    this.sweep(now)
    try {
      switch (action as InternalAction) {
        case "kill":
          return this.kill(body, now)
        case "suspend":
          return this.suspend(body)
        case "presence":
          return answer(this.presence())
        case "devices":
          return answer(this.deviceList(now))
        case "revoke-device":
          return this.revokeDevice(body, now)
        case "flags":
          return await this.flags(body)
        default:
          return failure(404, "RELAY_NOT_FOUND")
      }
    } finally {
      await this.settle(now)
    }
  }

  /** Revokes every connection whose ticket was issued before `before` (default now), and refuses such tickets. */
  private kill(body: Record<string, unknown>, now: number) {
    if (body.before !== undefined && (typeof body.before !== "number" || !Number.isSafeInteger(body.before)))
      return failure(400, "INTERNAL_BAD_REQUEST")
    const before = Math.min(typeof body.before === "number" ? body.before : now, now)
    const revokedBefore = Math.max(this.meta<number>("revoked_before") ?? 0, before)
    this.setMeta("revoked_before", revokedBefore)
    let closed = 0
    for (const socket of this.live()) {
      const attachment = this.attachment(socket)
      if (!attachment || attachment.iat * 1000 < revokedBefore) {
        this.drop(socket, CLOSE.REMOTE_REVOKED)
        closed++
      }
    }
    return answer({ revokedBefore, closed })
  }

  /**
   * Paused, frozen or an owner hold (§4.4): close everything and refuse new connections until lifted. `at` orders the
   * updates, so one delivered late never undoes a newer one.
   */
  private suspend(body: Record<string, unknown>) {
    const reason = body.reason ?? "paused"
    if (
      typeof body.suspended !== "boolean" ||
      typeof body.at !== "number" ||
      !Number.isSafeInteger(body.at) ||
      body.at <= 0 ||
      !SUSPEND_REASONS.includes(reason as SuspendReason)
    )
      return failure(400, "INTERNAL_BAD_REQUEST")
    if (body.at < (this.meta<number>("suspend_at") ?? 0))
      return answer({ applied: false, suspended: this.meta<Suspension>("suspended") !== undefined, closed: 0 })
    this.setMeta("suspend_at", body.at)
    if (!body.suspended) {
      this.deleteMeta("suspended")
      return answer({ applied: true, suspended: false, closed: 0 })
    }
    this.setMeta("suspended", { reason: reason as SuspendReason, at: body.at } satisfies Suspension)
    const sockets = this.live()
    for (const socket of sockets) this.drop(socket, CLOSE.REMOTE_PAUSED)
    return answer({ applied: true, suspended: true, closed: sockets.length })
  }

  /** The presence query behind `isComputerOnline(account)` (§4.17). */
  private presence() {
    const computers = this.peers("computer")
    return {
      online: computers.length > 0,
      computers: computers.map((peer) => ({ device: peer.device, ...(peer.name ? { name: peer.name } : {}) })),
      viewers: this.live("phone").length,
    }
  }

  private deviceList(now: number) {
    const online = new Set(this.live().flatMap((socket) => this.attachment(socket)?.dev ?? []))
    const devices = (["computer", "phone"] as const).flatMap((role) =>
      this.activeDevices(role).map((row, index) => ({
        device: row.id,
        role,
        ...(row.name ? { name: row.name } : {}),
        ...(row.public_key ? { key: row.public_key } : {}),
        pairedAt: row.paired_at,
        lastSeen: row.last_seen,
        online: online.has(row.id),
        overLimit: index >= this.limit(role),
      })),
    )
    return {
      devices,
      limits: { computers: this.limit("computer"), phones: this.limit("phone") },
      fairUse: this.fairUse(now),
    }
  }

  /**
   * Revokes one device: its connections close, its name and key are forgotten, and its id is refused from now on (a
   * device pairs again under a new id). It no longer counts toward the caps.
   */
  private revokeDevice(body: Record<string, unknown>, now: number) {
    if (!isDeviceId(body.device)) return failure(400, "INTERNAL_BAD_REQUEST")
    if (this.device(body.device))
      this.sql(
        "UPDATE devices SET revoked_at = coalesce(revoked_at, ?), name = NULL, public_key = NULL WHERE id = ?",
        now,
        body.device,
      )
    else
      this.sql(
        "INSERT INTO devices (id, role, paired_at, last_seen, revoked_at) VALUES (?, 'revoked', ?, ?, ?)",
        body.device,
        now,
        now,
        now,
      )
    const sockets = this.live(`dev:${body.device}`)
    for (const socket of sockets) this.drop(socket, CLOSE.REMOTE_REVOKED)
    return answer({ revoked: true, closed: sockets.length })
  }

  /** Account deletion (P5, called by A57): every connection closes and everything stored here is deleted. */
  private async erase(now: number) {
    for (const socket of this.live()) this.drop(socket, CLOSE.REMOTE_REVOKED)
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.plan = undefined
    this.awakePending = 0
    this.flushedAt = now
    this.announced = {}
    this.migrate()
    return answer({ erased: true })
  }

  /** The Worker's kill flag, written by the API when the owner's `remote` switch changes (any account's object). */
  private async flags(body: Record<string, unknown>) {
    if (typeof body.kill !== "boolean") return failure(400, "INTERNAL_BAD_REQUEST")
    if (body.kill) await this.env.REMOTE_FLAGS.put(KILL_KEY, "1")
    else await this.env.REMOTE_FLAGS.delete(KILL_KEY)
    return answer({ kill: body.kill })
  }

  // Storage and small helpers

  private migrate() {
    for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement)
  }

  private sql<Row extends Record<string, SqlValue> = Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): Row[] {
    return this.ctx.storage.sql.exec<Row>(query, ...bindings).toArray()
  }

  private meta<T>(key: string): T | undefined {
    const row = this.sql<{ v: string }>("SELECT v FROM meta WHERE k = ?", key)[0]
    if (!row) return undefined
    try {
      return JSON.parse(row.v) as T
    } catch {
      return undefined
    }
  }

  private setMeta(key: string, value: unknown) {
    this.sql(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      key,
      JSON.stringify(value),
    )
  }

  private deleteMeta(key: string) {
    this.sql("DELETE FROM meta WHERE k = ?", key)
  }

  /** Records an id (a ticket's jti, an internal nonce) once; false when it was already seen and has not expired. */
  private once(id: string, expiresAt: number, now: number) {
    this.sql("DELETE FROM seen WHERE expires_at < ?", now)
    if (this.sql("SELECT 1 AS hit FROM seen WHERE id = ?", id).length) return false
    this.sql("INSERT INTO seen (id, expires_at) VALUES (?, ?)", id, expiresAt)
    return true
  }

  private device(id: string) {
    return this.sql<DeviceRow>("SELECT * FROM devices WHERE id = ?", id)[0]
  }

  private activeDevices(role: DeviceRole) {
    return this.sql<DeviceRow>(
      "SELECT * FROM devices WHERE role = ? AND revoked_at IS NULL ORDER BY paired_at, id",
      role,
    )
  }

  private live(tag?: string) {
    return this.ctx.getWebSockets(tag).filter((socket) => socket.readyState === 1 && !this.closing.has(socket))
  }

  private attachment(socket: RelaySocket): Attachment | undefined {
    let value: unknown
    try {
      value = socket.deserializeAttachment()
    } catch {
      return undefined
    }
    if (!value || typeof value !== "object") return undefined
    const attachment = value as Attachment
    return attachment.v === 1 &&
      (attachment.role === "computer" || attachment.role === "phone") &&
      isDeviceId(attachment.dev)
      ? attachment
      : undefined
  }

  private drop(socket: RelaySocket, code: CloseCode) {
    this.closing.add(socket)
    try {
      socket.close(code, CLOSE_REASON[code])
    } catch {
      // Already closed.
    }
  }

  private async dropAndSettle(socket: RelaySocket, code: CloseCode, now: number) {
    this.drop(socket, code)
    await this.settle(now)
  }

  private idBytes(device: string) {
    let bytes = this.ids.get(device)
    if (!bytes) {
      bytes = fromBase64url(device)!
      this.ids.set(device, bytes)
    }
    return bytes
  }

  private async verify(ticket: string, now: number) {
    const check = await verifyTicket(ticket, await importTicketKeys(this.env.TICKET_PUBLIC_KEYS), now)
    return check.ok ? check.claims : undefined
  }

  /** The kill flag. A flag that cannot be read counts as set: the relay fails closed. */
  private async killed() {
    try {
      return (await this.env.REMOTE_FLAGS.get(KILL_KEY)) === "1"
    } catch {
      return true
    }
  }
}

function opposite(role: DeviceRole): DeviceRole {
  return role === "phone" ? "computer" : "phone"
}

export function answer(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

export function failure(status: number, code: string) {
  return answer({ error: { code } }, status)
}
