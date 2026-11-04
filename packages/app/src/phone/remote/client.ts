import {
  CLOSE,
  CONNECT_PATH,
  FRAME,
  HEARTBEAT,
  RELAY_SUBPROTOCOL,
  decodeFrame,
  encodeFrame,
  isDeviceId,
  type Peer,
  type ServerMessage,
} from "@vectordevai/relay/protocol"
import {
  Channel,
  checkCode,
  computerProof,
  credentialHash,
  deviceBytes,
  ENVELOPE,
  equalBytes,
  fromBase64url,
  generateDeviceIdentity,
  openPair,
  openPairDone,
  pairDoneKey,
  pairingTranscript,
  passkeyChallenge,
  phoneFinish,
  phoneInit,
  phoneProof,
  randomDeviceId,
  readPairingLink,
  sealPair,
  toBase64url,
  x25519Supported,
  type PairingOffer,
} from "@vectordevai/core/remote/crypto"
import { negotiate, phoneHello } from "../version"
import { PasskeyError, type PasskeyAdapter } from "./passkey"
import type { PairedComputer, PhoneIdentity, RemoteRecord, RemoteStore } from "./store"

// Vector Remote's phone half (WP A42). The desktop half is packages/desktop/src/main/remote-link.ts (A41); both speak
// the protocol in packages/core/src/remote/crypto.ts through the relay (packages/relay, A39), which sees only public
// keys and sealed bytes.
//
// - A ticket comes from `POST /api/remote/ticket` (A40) with this phone's own website session, sent from the phone
//   app's origin; the relay is opened at the address the ticket names, offering `vector.v1` and the ticket. A ping goes
//   every 25 s and the ticket is refreshed in-band a minute before it expires.
// - The relay closes a phone that sends no data for 30 minutes, so this sends data only when the person does
//   something (opens Remote, pairs, asks for sessions, answers a request); it reconnects when they come back, never on
//   its own in a loop.
// - Pairing reads the QR's link (the offer is in its fragment), makes a passkey bound to the pairing transcript, sends
//   the sealed request, shows the six digits the computer shows, and keeps the computer's key once the computer says
//   the person confirmed them.
// - Each paired computer that is online gets its own encrypted channel. Requests go through the computer's route
//   allowlist; allowing a permission request is "once" with a passkey the computer verifies, or a denial. There is no
//   "always" here at all (S6).

export type RemoteSocket = {
  readonly readyState: number
  binaryType: string
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** A call to Vector's API on the phone origin with this phone's session (api.ts `phoneApi`). It throws on refusal. */
export type RemoteApi = (path: string, init: { method: string; body?: unknown }) => Promise<Record<string, unknown>>

export type PhoneRemoteDependencies = {
  /** The phone app's own origin; pairing links and passkeys use exactly it. */
  origin: string
  api: RemoteApi
  store: RemoteStore
  socket: (url: string, protocols: string[]) => RemoteSocket
  /** Whether the relay's address is the one this app may connect to (the phone origin's CSP names it too). */
  relayAllowed: (url: URL) => boolean
  passkeys: PasskeyAdapter
  alertKeys: { save(id: string, raw: Uint8Array): Promise<void>; remove(id: string): Promise<void>; forget(): Promise<void> }
  /** This phone's plain name ("iPhone"), shown on the computer and in Devices. */
  phoneName: () => string
  now?: () => number
  timing?: Partial<{ heartbeatMs: number; requestMs: number; channelMs: number; refreshEarlyMs: number; retryMs: number }>
}

export type RemoteState =
  | "idle"
  | "connecting"
  | "online"
  | "offline"
  | "signed-out"
  | "not-in-plan"
  | "unavailable"
  | "paused"
  | "device-limit"
  | "fair-use"
  | "revoked"
  | "replaced"
  | "idle-closed"
  | "unsupported"

export type ChannelState = "offline" | "opening" | "open" | "not-paired" | "update-phone" | "update-desktop"

export type ComputerView = { device: string; name: string; pairedAt: number; online: boolean; channel: ChannelState }

export type PairingView =
  | { state: "idle" }
  | { state: "connecting"; name?: string; expiresAt: number }
  | { state: "ready"; name?: string; expiresAt: number; message?: string }
  | { state: "sent"; name?: string; expiresAt: number }
  | { state: "confirm"; code: string; name?: string; expiresAt: number }
  | { state: "paired"; name: string }
  | { state: "failed"; message: string }

export type RemoteView = {
  state: RemoteState
  message?: string
  /** This phone's relay device id, once it has one. */
  device?: string
  computers: ComputerView[]
  pairing: PairingView
}

export type EngineAnswer = { status: number; body: unknown }
export type EngineEvent = { directory: string; type: string; properties: unknown; truncated?: boolean }
export type RemoteRequest = {
  method: "GET" | "POST"
  path: string
  directory?: string
  query?: Record<string, string>
  body?: unknown
}

/** Allowing once: done, or a passkey prompt the browser wants from a fresh tap (`confirm` runs it). */
export type ApprovalResult =
  | { kind: "answered"; answer: EngineAnswer }
  | { kind: "tap"; confirm: () => Promise<ApprovalResult> }

export class RemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const HEARTBEAT_MS = 25_000
const REQUEST_MS = 30_000
const CHANNEL_MS = 10_000
const REFRESH_EARLY_MS = 60_000
/** A kill lands in whole seconds at the relay, so the one retry after REMOTE_REVOKED waits past the second. */
const RETRY_MS = 1_500

const MESSAGES: Partial<Record<RemoteState, string>> = {
  "signed-out": "Sign in again to use Vector Remote.",
  "not-in-plan": "Your Vector Codium plan does not include Vector Remote right now.",
  unavailable: "Vector Remote is not available right now. Try again later.",
  offline: "Vector could not reach Vector Remote. Check your connection.",
  paused: "Your Vector Codium plan is paused, so Vector Remote is off until its payment goes through.",
  "device-limit":
    "This account already has as many phones or computers as its plan allows. Remove one in Devices, then try again.",
  "fair-use": "Vector Remote reached this month's fair-use limit. It comes back when your plan renews.",
  revoked: "This phone was removed from Vector Remote. Set it up again to pair.",
  replaced: "Vector Remote opened in another window on this phone. Open it here again to use it here.",
  "idle-closed": "Disconnected after 30 minutes without activity.",
  unsupported: "This browser cannot run Vector Remote's encryption. Update it, then try again.",
}

type Pending = {
  resolve: (answer: EngineAnswer) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  parts?: (string | undefined)[]
}

type Link = {
  state: ChannelState
  channel?: Channel
  init?: Awaited<ReturnType<typeof phoneInit>>["pending"]
  timer?: ReturnType<typeof setTimeout>
  next: number
  requests: Map<number, Pending>
  opened: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
  watching: boolean
}

type Pairing = {
  offer: PairingOffer
  secret: Uint8Array
  computerKey: Uint8Array
  transcript: Uint8Array
  challenge: Uint8Array
  state: "connecting" | "ready" | "sent" | "confirm"
  message?: string
  hash?: Uint8Array
  credential?: string
  code?: string
  timer?: ReturnType<typeof setTimeout>
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  // A channel that never opens must not leave an unhandled rejection behind.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

export function createPhoneRemote(deps: PhoneRemoteDependencies) {
  const now = deps.now ?? Date.now
  const timing = {
    heartbeatMs: HEARTBEAT_MS,
    requestMs: REQUEST_MS,
    channelMs: CHANNEL_MS,
    refreshEarlyMs: REFRESH_EARLY_MS,
    retryMs: RETRY_MS,
    ...deps.timing,
  }
  const rpId = new URL(deps.origin).hostname
  const listeners = new Set<(view: RemoteView) => void>()
  const eventListeners = new Set<(computer: string, events: EngineEvent[]) => void>()
  const state: {
    record?: RemoteRecord
    loading?: Promise<RemoteRecord>
    socket?: RemoteSocket
    connecting?: Promise<void>
    status: RemoteState
    message?: string
    peers: Map<string, Peer>
    links: Map<string, Link>
    heartbeat?: ReturnType<typeof setInterval>
    refresher?: ReturnType<typeof setTimeout>
    retry?: ReturnType<typeof setTimeout>
    revokedOnce: boolean
    pairing?: Pairing
    pairingResult: PairingView
  } = {
    status: "idle",
    peers: new Map(),
    links: new Map(),
    revokedOnce: false,
    pairingResult: { state: "idle" },
  }

  const load = async () => {
    if (state.record) return state.record
    state.loading ??= deps.store
      .read()
      .catch(() => ({ computers: [] }) as RemoteRecord)
      .then((record) => (state.record = record))
    return state.loading
  }

  const save = async (record: RemoteRecord) => {
    state.record = record
    await deps.store.write(record)
  }

  const identity = async (): Promise<PhoneIdentity> => {
    const record = await load()
    if (record.identity) return record.identity
    const keys = await generateDeviceIdentity()
    const made: PhoneIdentity = { v: 1, device: randomDeviceId(), ...keys, createdAt: now() }
    await save({ ...record, identity: made })
    return made
  }

  const pairingView = (): PairingView => {
    const pairing = state.pairing
    if (!pairing) return state.pairingResult
    const name = pairing.offer.name
    const expiresAt = pairing.offer.exp * 1_000
    if (pairing.state === "confirm") return { state: "confirm", code: pairing.code!, ...(name ? { name } : {}), expiresAt }
    if (pairing.state === "ready")
      return { state: "ready", ...(name ? { name } : {}), expiresAt, ...(pairing.message ? { message: pairing.message } : {}) }
    return { state: pairing.state, ...(name ? { name } : {}), expiresAt }
  }

  const view = (): RemoteView => ({
    state: state.status,
    ...(state.message ? { message: state.message } : {}),
    ...(state.record?.identity ? { device: state.record.identity.device } : {}),
    computers: (state.record?.computers ?? []).map((computer) => ({
      device: computer.device,
      name: computer.name,
      pairedAt: computer.pairedAt,
      online: state.peers.has(computer.device),
      channel: state.links.get(computer.device)?.state ?? "offline",
    })),
    pairing: pairingView(),
  })

  const emit = () => {
    const current = view()
    for (const listener of listeners) listener(current)
  }

  const setStatus = (next: RemoteState, message = MESSAGES[next]) => {
    state.status = next
    state.message = message
    emit()
  }

  // ── Frames ──────────────────────────────────────────────────────────────────────────────────────────────────────

  const sendFrame = (computer: string, envelope: Uint8Array) => {
    const socket = state.socket
    if (!socket || socket.readyState !== 1) throw new RemoteError("REMOTE_OFFLINE", "Vector Remote is not connected.")
    socket.send(encodeFrame(FRAME.DATA, deviceBytes(computer), envelope))
  }

  const sendMessage = async (computer: string, link: Link, message: unknown) => {
    if (!link.channel) throw new RemoteError("REMOTE_OFFLINE", "That computer is not connected.")
    sendFrame(computer, await link.channel.seal(message))
  }

  const failLink = (link: Link, error: Error) => {
    if (link.timer) clearTimeout(link.timer)
    link.timer = undefined
    for (const pending of link.requests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    link.requests.clear()
    link.opened.reject(error)
  }

  const dropLink = (computer: string, next: ChannelState = "offline") => {
    const link = state.links.get(computer)
    if (!link) return
    failLink(link, new RemoteError("REMOTE_OFFLINE", "That computer is not connected."))
    if (next === "offline") state.links.delete(computer)
    else {
      link.state = next
      link.channel = undefined
    }
  }

  const paired = (computer: string) => state.record?.computers.find((item) => item.device === computer)

  const openLink = async (computer: PairedComputer) => {
    const existing = state.links.get(computer.device)
    if (existing && (existing.state === "open" || existing.state === "opening")) return existing
    const mine = await identity()
    const link: Link = existing ?? {
      state: "opening",
      next: 0,
      requests: new Map(),
      opened: deferred(),
      watching: false,
    }
    if (existing) {
      link.opened = deferred()
      link.state = "opening"
    }
    state.links.set(computer.device, link)
    const started = await phoneInit({
      phonePrivate: mine.privateKey,
      peers: {
        computer: computer.device,
        computerKey: fromBase64url(computer.key),
        phone: mine.device,
        phoneKey: mine.publicKey,
      },
    })
    link.init = started.pending
    link.timer = setTimeout(() => {
      // A computer that does not answer a paired phone's INIT no longer has this phone paired.
      if (link.state !== "opening") return
      failLink(link, new RemoteError("REMOTE_NOT_PAIRED", "That computer no longer has this phone paired."))
      link.state = "not-paired"
      emit()
    }, timing.channelMs)
    emit()
    try {
      sendFrame(computer.device, started.envelope)
    } catch (error) {
      dropLink(computer.device)
      emit()
      throw error
    }
    return link
  }

  const onAccept = async (computer: string, envelope: Uint8Array) => {
    const link = state.links.get(computer)
    if (!link?.init || link.state !== "opening") return
    const channel = await phoneFinish(link.init, envelope).catch(() => undefined)
    link.init = undefined
    if (!channel) {
      failLink(link, new RemoteError("REMOTE_NOT_PAIRED", "That computer is not the one this phone paired with."))
      link.state = "not-paired"
      emit()
      return
    }
    link.channel = channel
    await sendMessage(computer, link, { t: "hello", ...phoneHello() }).catch(() => {})
  }

  const onData = async (computer: string, envelope: Uint8Array) => {
    const link = state.links.get(computer)
    if (!link?.channel) return
    const message = (await link.channel.open(envelope).catch(() => undefined)) as Record<string, unknown> | undefined
    if (!message || typeof message !== "object") return
    if (message.t === "hello") {
      const handshake = negotiate(phoneHello(), message)
      if (link.timer) clearTimeout(link.timer)
      link.timer = undefined
      if (!handshake.ok) {
        failLink(link, new RemoteError("REMOTE_UPDATE", "Update Vector to use this computer from your phone."))
        link.state = handshake.update === "phone" ? "update-phone" : "update-desktop"
        emit()
        return
      }
      link.state = "open"
      link.opened.resolve()
      if (link.watching) await sendMessage(computer, link, { t: "watch" }).catch(() => {})
      emit()
      return
    }
    if (message.t === "update") {
      failLink(link, new RemoteError("REMOTE_UPDATE", "Update Vector to use this computer from your phone."))
      link.state = message.side === "phone" ? "update-phone" : "update-desktop"
      emit()
      return
    }
    if (message.t === "res" && typeof message.id === "number") {
      const pending = link.requests.get(message.id)
      if (!pending) return
      const status = typeof message.status === "number" ? message.status : 500
      if (typeof message.parts === "number" && typeof message.part === "number") {
        const parts = message.parts
        if (!Number.isSafeInteger(parts) || parts < 1 || parts > 128 || message.part < 0 || message.part >= parts) return
        pending.parts ??= new Array<string | undefined>(parts).fill(undefined)
        if (typeof message.data !== "string") return
        pending.parts[message.part] = message.data
        if (pending.parts.some((part) => part === undefined)) return
        const bytes = pending.parts.map((part) => fromBase64url(part!))
        const joined = new Uint8Array(bytes.reduce((sum, part) => sum + part.byteLength, 0))
        let offset = 0
        for (const part of bytes) {
          joined.set(part, offset)
          offset += part.byteLength
        }
        link.requests.delete(message.id)
        clearTimeout(pending.timer)
        try {
          pending.resolve({ status, body: JSON.parse(new TextDecoder().decode(joined)) })
        } catch {
          pending.reject(new RemoteError("REMOTE_ANSWER", "The computer's answer could not be read."))
        }
        return
      }
      link.requests.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolve({ status, body: message.body ?? null })
      return
    }
    if (message.t === "events" && Array.isArray(message.events)) {
      const events = message.events.flatMap((item): EngineEvent[] => {
        if (!item || typeof item !== "object") return []
        const event = item as Record<string, unknown>
        if (typeof event.directory !== "string" || typeof event.type !== "string") return []
        return [
          {
            directory: event.directory,
            type: event.type,
            properties: event.properties ?? {},
            ...(event.truncated === true ? { truncated: true } : {}),
          },
        ]
      })
      if (events.length) for (const listener of eventListeners) listener(computer, events)
    }
  }

  // ── Pairing ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const endPairing = (result: PairingView) => {
    const pairing = state.pairing
    if (pairing?.timer) clearTimeout(pairing.timer)
    pairing?.secret.fill(0)
    state.pairing = undefined
    state.pairingResult = result
    emit()
  }

  const pairingReady = () => {
    const pairing = state.pairing
    if (pairing?.state === "connecting" && state.peers.has(pairing.offer.computer)) {
      pairing.state = "ready"
      emit()
    }
  }

  const onPair = async (computer: string, envelope: Uint8Array) => {
    const pairing = state.pairing
    const mine = state.record?.identity
    if (!pairing || !mine || computer !== pairing.offer.computer || pairing.state !== "sent") return
    const message = (await openPair(pairing.secret, computer, mine.device, envelope).catch(() => undefined)) as
      | Record<string, unknown>
      | undefined
    if (!message) return
    if (message.t === "pair-refused") {
      endPairing({
        state: "failed",
        message:
          message.reason === "in-use"
            ? "Another phone answered the same pairing code, so pairing stopped. Start again on the computer."
            : "The computer refused this phone's pairing request. Start again on the computer.",
      })
      return
    }
    if (message.t !== "pair-pending" || typeof message.proof !== "string" || !pairing.hash) return
    const expected = await computerProof(pairing.secret, pairing.transcript, pairing.hash)
    let proof: Uint8Array
    try {
      proof = fromBase64url(message.proof)
    } catch {
      proof = new Uint8Array(0)
    }
    if (!equalBytes(proof, expected)) {
      endPairing({ state: "failed", message: "That computer could not prove it showed this pairing code. Start again." })
      return
    }
    pairing.code = await checkCode(pairing.secret, pairing.transcript, pairing.hash)
    pairing.state = "confirm"
    emit()
  }

  const onPairDone = async (computer: string, envelope: Uint8Array) => {
    const pairing = state.pairing
    const mine = state.record?.identity
    if (!pairing || !mine || computer !== pairing.offer.computer || pairing.state !== "confirm") return
    const key = await pairDoneKey(mine.privateKey, pairing.computerKey, pairing.transcript)
    const message = (await openPairDone(key, computer, mine.device, envelope).catch(() => undefined)) as
      | Record<string, unknown>
      | undefined
    if (!message || message.t !== "pair-done") return
    let alertKeyId: string | undefined
    if (typeof message.alertKeyId === "string" && typeof message.alertKey === "string") {
      try {
        const raw = fromBase64url(message.alertKey)
        await deps.alertKeys.save(message.alertKeyId, raw)
        alertKeyId = message.alertKeyId
      } catch {}
    }
    const named = typeof message.name === "string" && message.name.trim() ? message.name.trim() : pairing.offer.name
    const record = await load()
    const entry: PairedComputer = {
      device: computer,
      key: pairing.offer.key,
      name: (named ?? "Computer").slice(0, 64),
      credential: pairing.credential!,
      ...(alertKeyId ? { alertKeyId } : {}),
      pairedAt: now(),
    }
    await save({ ...record, computers: [...record.computers.filter((item) => item.device !== computer), entry] })
    endPairing({ state: "paired", name: entry.name })
    if (state.peers.has(computer)) await openLink(entry).catch(() => {})
  }

  // ── The relay ───────────────────────────────────────────────────────────────────────────────────────────────────

  const receive = async (from: string, envelope: Uint8Array) => {
    if (envelope.byteLength === 0) return
    const kind = envelope[0]
    if (kind === ENVELOPE.PAIR) return onPair(from, envelope)
    if (kind === ENVELOPE.PAIR_DONE) return onPairDone(from, envelope)
    if (!paired(from)) return
    if (kind === ENVELOPE.ACCEPT) return onAccept(from, envelope)
    if (kind === ENVELOPE.DATA) return onData(from, envelope)
  }

  const syncPeers = async (peers: Peer[]) => {
    const computers = new Map(
      peers.filter((peer) => peer.role === "computer" && isDeviceId(peer.device)).map((peer) => [peer.device, peer]),
    )
    state.peers = computers
    for (const device of [...state.links.keys()]) if (!computers.has(device)) dropLink(device)
    pairingReady()
    for (const computer of state.record?.computers ?? []) {
      const peer = computers.get(computer.device)
      if (!peer || state.links.has(computer.device)) continue
      // The relay's peer list is not trusted for keys; one that disagrees with the QR's is not this computer.
      if (peer.key && peer.key !== computer.key) {
        state.links.set(computer.device, {
          state: "not-paired",
          next: 0,
          requests: new Map(),
          opened: deferred(),
          watching: false,
        })
        continue
      }
      await openLink(computer).catch(() => {})
    }
    emit()
  }

  const control = async (message: ServerMessage) => {
    if (message.t === "hello") {
      state.revokedOnce = false
      setStatus("online", undefined)
      await syncPeers(message.peers)
      return
    }
    if (message.t === "peers") await syncPeers(message.peers)
  }

  const teardown = () => {
    if (state.heartbeat) clearInterval(state.heartbeat)
    if (state.refresher) clearTimeout(state.refresher)
    state.heartbeat = undefined
    state.refresher = undefined
    state.socket = undefined
    state.peers = new Map()
    for (const device of [...state.links.keys()]) dropLink(device)
  }

  const clearRetry = () => {
    if (state.retry) clearTimeout(state.retry)
    state.retry = undefined
  }

  const closed = (code: number) => {
    teardown()
    // A pairing that had sent its request cannot finish without the connection: the computer's answer would be lost.
    // One still waiting for the computer, or for the tap, waits again once the phone reconnects.
    if (state.pairing?.state === "sent" || state.pairing?.state === "confirm")
      endPairing({ state: "failed", message: "The connection dropped while pairing. Start again on the computer." })
    else if (state.pairing) state.pairing.state = "connecting"
    if (code === CLOSE.REMOTE_REVOKED || code === CLOSE.TICKET_EXPIRED || code === CLOSE.STALE) {
      // "Disconnect all" closes every connection of the account and refuses earlier tickets: ask for one new ticket.
      if (!state.revokedOnce) {
        state.revokedOnce = true
        setStatus("connecting", undefined)
        clearRetry()
        state.retry = setTimeout(() => void connect(), timing.retryMs)
        return
      }
      if (code === CLOSE.REMOTE_REVOKED) return setStatus("revoked")
      return setStatus("offline")
    }
    if (code === CLOSE.REMOTE_PAUSED) return setStatus("paused")
    if (code === CLOSE.RELAY_OFF) return setStatus("unavailable")
    if (code === CLOSE.REMOTE_DEVICE_LIMIT) return setStatus("device-limit")
    if (code === CLOSE.REMOTE_FAIR_USE) return setStatus("fair-use")
    if (code === CLOSE.REPLACED) return setStatus("replaced")
    if (code === CLOSE.IDLE) return setStatus("idle-closed")
    setStatus("offline")
  }

  type Ticket = { ticket: string; url: URL; expiresAt: number }

  const mint = async (mine: PhoneIdentity): Promise<Ticket | { refused: RemoteState; message?: string }> => {
    let body: Record<string, unknown>
    try {
      body = await deps.api("/api/remote/ticket", {
        method: "POST",
        body: { role: "phone", device: mine.device, name: deps.phoneName().slice(0, 64) },
      })
    } catch (error) {
      const status = (error as { status?: unknown }).status
      const message = error instanceof Error && error.message ? error.message.slice(0, 300) : undefined
      if (status === 401) return { refused: "signed-out" }
      if (status === 402 || status === 403) return { refused: "not-in-plan", ...(message ? { message } : {}) }
      if (status === 0 || status === undefined) return { refused: "offline" }
      return { refused: "unavailable", ...(message ? { message } : {}) }
    }
    if (typeof body.ticket !== "string" || typeof body.url !== "string" || body.protocol !== RELAY_SUBPROTOCOL)
      return { refused: "unavailable" }
    let url: URL
    try {
      url = new URL(body.url)
    } catch {
      return { refused: "unavailable" }
    }
    if (!["wss:", "ws:"].includes(url.protocol) || url.pathname !== CONNECT_PATH || url.search || url.username)
      return { refused: "unavailable" }
    if (!deps.relayAllowed(url))
      return { refused: "unavailable", message: "This phone app cannot reach the relay Vector named. Update it." }
    const expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : now() + 300_000
    return { ticket: body.ticket, url, expiresAt }
  }

  const scheduleRefresh = (socket: RemoteSocket, mine: PhoneIdentity, expiresAt: number) => {
    if (state.refresher) clearTimeout(state.refresher)
    state.refresher = setTimeout(
      async () => {
        if (state.socket !== socket || socket.readyState !== 1) return
        const ticket = await mint(mine)
        if (!("ticket" in ticket) || state.socket !== socket || socket.readyState !== 1) return
        socket.send(JSON.stringify({ t: "refresh", ticket: ticket.ticket }))
        scheduleRefresh(socket, mine, ticket.expiresAt)
      },
      Math.max(1_000, expiresAt - now() - timing.refreshEarlyMs),
    )
  }

  const open = async () => {
    if (!(await x25519Supported())) return setStatus("unsupported")
    const mine = await identity()
    setStatus("connecting", undefined)
    const ticket = await mint(mine)
    if (!("ticket" in ticket)) return setStatus(ticket.refused, ticket.message)
    let socket: RemoteSocket
    try {
      socket = deps.socket(ticket.url.href, [RELAY_SUBPROTOCOL, ticket.ticket])
    } catch {
      return setStatus("offline")
    }
    socket.binaryType = "arraybuffer"
    state.socket = socket
    socket.onopen = () => {
      if (state.socket !== socket) return
      state.heartbeat = setInterval(() => {
        if (socket.readyState === 1) socket.send(HEARTBEAT.request)
      }, timing.heartbeatMs)
      scheduleRefresh(socket, mine, ticket.expiresAt)
    }
    socket.onmessage = (event) => {
      if (state.socket !== socket) return
      void onMessage(event.data).catch(() => {})
    }
    socket.onerror = () => {}
    socket.onclose = (event) => {
      if (state.socket !== socket) return
      closed(event.code)
    }
  }

  const onMessage = async (data: unknown) => {
    if (typeof data === "string") {
      if (data === HEARTBEAT.response) return
      let message: unknown
      try {
        message = JSON.parse(data)
      } catch {
        return
      }
      if (message && typeof message === "object" && typeof (message as { t?: unknown }).t === "string")
        await control(message as ServerMessage)
      return
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : undefined
    if (!bytes) return
    const frame = decodeFrame(bytes)
    if (!frame || frame.kind !== FRAME.DATA) return
    await receive(toBase64url(frame.device), frame.ciphertext.slice())
  }

  /** Opens the relay connection (from something the person did). Resolves once a ticket was asked for. */
  const connect = async () => {
    clearRetry()
    if (state.socket) return
    state.connecting ??= open().finally(() => (state.connecting = undefined))
    return state.connecting
  }

  const waitOpen = async (computer: string) => {
    await connect()
    const entry = paired(computer)
    if (!entry) throw new RemoteError("REMOTE_NOT_PAIRED", "This phone is not paired with that computer.")
    if (!state.peers.has(computer)) throw new RemoteError("REMOTE_OFFLINE", "That computer is not connected.")
    const link = await openLink(entry)
    if (link.state === "open") return link
    await link.opened.promise
    return link
  }

  const request = async (computer: string, input: RemoteRequest): Promise<EngineAnswer> => {
    const link = await waitOpen(computer)
    const id = ++link.next
    const answer = new Promise<EngineAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.requests.delete(id)
        reject(new RemoteError("REMOTE_TIMEOUT", "The computer did not answer in time."))
      }, timing.requestMs)
      link.requests.set(id, { resolve, reject, timer })
    })
    answer.catch(() => {})
    try {
      await sendMessage(computer, link, {
        t: "req",
        id,
        method: input.method,
        path: input.path,
        ...(input.directory !== undefined ? { directory: input.directory } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      })
    } catch (error) {
      const pending = link.requests.get(id)
      if (pending) clearTimeout(pending.timer)
      link.requests.delete(id)
      throw error
    }
    return answer
  }

  const allowOnce = async (
    computer: string,
    directory: string,
    requestID: string,
    challenge: { challenge: string; expiresAt: number },
  ): Promise<ApprovalResult> => {
    const entry = paired(computer)
    if (!entry) throw new RemoteError("REMOTE_NOT_PAIRED", "This phone is not paired with that computer.")
    let passkey
    try {
      passkey = await deps.passkeys.get({ challenge: challenge.challenge, rpId, credential: entry.credential })
    } catch (error) {
      // Safari asks for a passkey only straight from a tap; the challenge is kept for the next one.
      if (error instanceof PasskeyError && error.reason === "cancelled" && challenge.expiresAt - now() > 10_000)
        return { kind: "tap", confirm: () => allowOnce(computer, directory, requestID, challenge) }
      throw error
    }
    const answer = await request(computer, {
      method: "POST",
      path: `/permission/${requestID}/reply`,
      directory,
      body: { reply: "once", passkey },
    })
    return { kind: "answered", answer }
  }

  return {
    view,
    subscribe(listener: (view: RemoteView) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onEvents(listener: (computer: string, events: EngineEvent[]) => void) {
      eventListeners.add(listener)
      return () => void eventListeners.delete(listener)
    },
    /** Reads what this phone has stored; the view then lists its paired computers. */
    async load() {
      await load()
      emit()
    },
    connect,
    /** Closes the relay connection. */
    disconnect() {
      clearRetry()
      const socket = state.socket
      teardown()
      try {
        socket?.close(1000, "bye")
      } catch {}
      setStatus("idle", undefined)
    },
    /** The pairing link the QR code holds: checked, then the relay is opened to wait for that computer. */
    async startPairing(link: string) {
      const offer = readPairingLink(deps.origin, link.trim())
      if (!offer) return endPairing({ state: "failed", message: "That is not a Vector Remote pairing code." })
      if (offer.exp * 1_000 <= now())
        return endPairing({ state: "failed", message: "That pairing code expired. Start again on the computer." })
      if (state.pairing) endPairing({ state: "idle" })
      if (!(await x25519Supported())) return setStatus("unsupported")
      const mine = await identity()
      const secret = fromBase64url(offer.secret)
      const computerKey = fromBase64url(offer.key)
      const transcript = await pairingTranscript({
        computer: offer.computer,
        computerKey,
        phone: mine.device,
        phoneKey: mine.publicKey,
        exp: offer.exp,
      })
      const pairing: Pairing = {
        offer,
        secret,
        computerKey,
        transcript,
        challenge: await passkeyChallenge(secret, transcript),
        state: "connecting",
      }
      pairing.timer = setTimeout(
        () => {
          if (state.pairing === pairing)
            endPairing({ state: "failed", message: "That pairing code expired. Start again on the computer." })
        },
        Math.max(0, offer.exp * 1_000 - now()),
      )
      state.pairing = pairing
      state.pairingResult = { state: "idle" }
      emit()
      await connect()
      pairingReady()
    },
    /** From the person's tap: makes this computer's passkey and sends the sealed pairing request. */
    async pair() {
      const pairing = state.pairing
      const mine = state.record?.identity
      if (!pairing || !mine || pairing.state !== "ready") return
      let registration
      try {
        registration = await deps.passkeys.create({
          challenge: pairing.challenge,
          rpId,
          computerName: pairing.offer.name ?? "computer",
        })
      } catch (error) {
        if (state.pairing === pairing) {
          pairing.message = error instanceof Error ? error.message : "The passkey did not work. Try again."
          emit()
        }
        return
      }
      if (state.pairing !== pairing) return
      const hash = await credentialHash(registration)
      const proof = await phoneProof(pairing.secret, pairing.transcript, hash)
      pairing.hash = hash
      pairing.credential = registration.id
      const envelope = await sealPair(pairing.secret, mine.device, pairing.offer.computer, {
        t: "pair-request",
        v: 1,
        key: toBase64url(mine.publicKey),
        name: deps.phoneName().slice(0, 64),
        registration: {
          clientDataJSON: toBase64url(registration.clientDataJSON),
          attestationObject: toBase64url(registration.attestationObject),
        },
        proof: toBase64url(proof),
        hello: phoneHello(),
      })
      try {
        sendFrame(pairing.offer.computer, envelope)
      } catch {
        pairing.message = "Vector Remote is not connected. Try again."
        emit()
        return
      }
      pairing.state = "sent"
      pairing.message = undefined
      emit()
    },
    cancelPairing() {
      endPairing({ state: "idle" })
    },
    request,
    /** Live events from a computer while this phone watches it. */
    async watch(computer: string, on: boolean) {
      const link = state.links.get(computer)
      if (link) link.watching = on
      if (!on) {
        if (link?.state === "open") await sendMessage(computer, link, { t: "unwatch" }).catch(() => {})
        return
      }
      const opened = await waitOpen(computer)
      opened.watching = true
      await sendMessage(computer, opened, { t: "watch" })
    },
    /**
     * Allows a permission request once: the computer issues a challenge for it, this phone's passkey signs it, and the
     * computer checks the signature before answering "once". Never "always".
     */
    async approve(computer: string, directory: string, requestID: string): Promise<ApprovalResult> {
      const answer = await request(computer, { method: "POST", path: "/remote/approval", directory, body: { requestID } })
      const body = answer.body as Record<string, unknown> | null
      if (answer.status !== 200 || typeof body?.challenge !== "string") return { kind: "answered", answer }
      const expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : now() + 60_000
      return allowOnce(computer, directory, requestID, { challenge: body.challenge, expiresAt })
    },
    deny(computer: string, directory: string, requestID: string, message?: string) {
      return request(computer, {
        method: "POST",
        path: `/permission/${requestID}/reply`,
        directory,
        body: { reply: "reject", ...(message?.trim() ? { message: message.trim().slice(0, 2_000) } : {}) },
      })
    },
    /** Removes a computer from this phone only. */
    async forget(computer: string) {
      const record = await load()
      const link = state.links.get(computer)
      if (link?.state === "open") await sendMessage(computer, link, { t: "bye" }).catch(() => {})
      dropLink(computer)
      const removed = record.computers.find((item) => item.device === computer)
      await save({ ...record, computers: record.computers.filter((item) => item.device !== computer) })
      // Its alerts stop opening here too.
      if (removed?.alertKeyId) await deps.alertKeys.remove(removed.alertKeyId).catch(() => {})
      emit()
    },
    /**
     * Starts this phone over with a new device id and keys, forgetting every computer: after the relay removed it,
     * or when the person asks. The old device is revoked first, so it no longer counts toward the account's phones.
     */
    async reset() {
      const record = await load()
      const old = record.identity?.device
      clearRetry()
      const socket = state.socket
      teardown()
      try {
        socket?.close(1000, "bye")
      } catch {}
      if (state.pairing) endPairing({ state: "idle" })
      if (old)
        await deps
          .api(`/api/remote/devices/${encodeURIComponent(old)}/revoke`, { method: "POST", body: {} })
          .catch(() => {})
      await deps.store.clear()
      await deps.alertKeys.forget().catch(() => {})
      state.record = { computers: [] }
      state.loading = undefined
      state.revokedOnce = false
      state.pairingResult = { state: "idle" }
      setStatus("idle", undefined)
    },
    /** Signing out: the connection closes and nothing of Remote stays on this phone. */
    async signOut() {
      clearRetry()
      const socket = state.socket
      teardown()
      try {
        socket?.close(1000, "bye")
      } catch {}
      if (state.pairing) endPairing({ state: "idle" })
      await deps.store.clear().catch(() => {})
      state.record = { computers: [] }
      state.loading = undefined
      setStatus("idle", undefined)
    },
  }
}

export type PhoneRemote = ReturnType<typeof createPhoneRemote>
