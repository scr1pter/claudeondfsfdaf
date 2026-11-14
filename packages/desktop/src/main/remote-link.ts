import {
  CLOSE,
  FRAME,
  HEARTBEAT,
  RELAY_SUBPROTOCOL,
  decodeFrame,
  encodeFrame,
  type ServerMessage,
} from "@vectordevai/relay/protocol"
import { computerAccept, deviceBytes, ENVELOPE, fromBase64url, toBase64url, type Channel } from "./remote-crypto"
import {
  createRemotePairing,
  decodeIdentity,
  MAX_PHONES,
  newIdentity,
  REMOTE_MIN_PHONE_PROTOCOL,
  REMOTE_PROTOCOL,
  type PairedPhone,
  type PairingStatus,
  type RemoteIdentity,
} from "./remote-pairing"
import { createPasskeyApprovals } from "./remote-passkey"
import {
  createRemoteRoutes,
  createRemoteTurns,
  projectDirectories,
  type EngineAnswer,
  type EngineRequest,
} from "./remote-routes"

// Vector Remote's desktop half (WP A41): the one connection this computer keeps to the account's relay, and everything
// that travels on it.
//
// - Tickets come from vectordev.ai (`POST /api/remote/ticket`, A40) with the desktop sign-in; the relay is reached at
//   the address the ticket names, offering `vector.v1` and the ticket (relay protocol.ts). A ping goes every 25 s. When
//   the relay says a phone arrived (`peers` with `refresh`), and every four minutes while a phone stays, the ticket is
//   refreshed in-band.
// - The connection is kept only while Remote is on, a phone is paired or a pairing is open, and the plan allows it
//   (the API and the relay decide that from the account's plan; nothing here grants anything, S1).
// - Each phone that connects opens its own encrypted channel (remote-crypto.ts). Requests go through the route
//   allowlist (remote-routes.ts); permission answers need the phone's passkey (remote-passkey.ts).
// - The engine's events are read and streamed only while a phone is attached and watching, at most four batches a
//   second to each phone (two once more than three phones watch), inside the relay's frame budget.
// - While a phone watches, keep-awake holds the computer awake for busy sessions, those waiting on a person included,
//   because the phone can answer them.
// - "Disconnect all phones" makes a new identity (a new device id, static key and alert key), closes every relay
//   connection of the account (`POST /api/remote/kill`) and frees the old device's place
//   (`POST /api/remote/devices/<id>/revoke`). No phone paired before can connect to this computer again.

const API = "https://vectordev.ai/api/remote"
const HEARTBEAT_MS = 25_000
const REFRESH_MS = 4 * 60_000
const BATCH_MS = 250
const CHUNK_BYTES = 40_000
const EVENT_BYTES = 16_000
const FRAMES_PER_SECOND = 16
const BURST = 32
const DIRECTORIES_MS = 30_000
const STREAMED = new Set([
  "session.status",
  "session.idle",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.error",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "todo.updated",
])

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

export type RemoteState =
  | "off"
  | "ready"
  | "signed-out"
  | "connecting"
  | "online"
  | "paused"
  | "not-in-plan"
  | "unavailable"
  | "device-limit"
  | "fair-use"
  | "revoked"
  | "replaced"
  | "local-off"

export type RemoteStatus = {
  enabled: boolean
  state: RemoteState
  message?: string
  phones: { device: string; name: string; pairedAt: number; connected: boolean; watching: boolean }[]
  limit: number
  /** Phones attached to the relay right now, as the relay counts them. */
  viewers: number
  pairing: PairingStatus
}

export type EngineEvent = { directory?: string; payload: { type: string; properties?: unknown } }

export type LinkDependencies = {
  /** The sealed identity (remote-runtime.ts): read it, write it. */
  store: { read(): Promise<unknown>; write(identity: RemoteIdentity): Promise<void> }
  enabled: { get(): boolean; set(value: boolean): void }
  token: () => Promise<string | undefined>
  /** A request to vectordev.ai, labelled for Vector Local (`remote`). */
  api: (url: string, init: RequestInit) => Promise<Response>
  /** Whether Vector Local lets this computer reach the relay at `url`. */
  allowed: (url: string) => boolean
  socket: (url: string, protocols: string[]) => RemoteSocket
  engine: {
    request(request: EngineRequest): Promise<EngineAnswer>
    events(signal: AbortSignal): AsyncIterable<EngineEvent>
  }
  /** The phone app's origin, exactly (VECTOR_PHONE_APP_ORIGIN). */
  origin: string
  /** This computer's name, shown on paired phones; it travels only end-to-end encrypted or in the local QR code. */
  computerName: () => string
  /** The name the relay lists this computer under (Settings > Devices): a plain kind of computer, not its name. */
  relayName?: () => string
  /** Called when whether a phone watches changes, so keep-awake reads `watching()` again. */
  watchingChanged?: () => void
  changed?: (status: RemoteStatus) => void
  log?: (message: string, meta?: Record<string, unknown>) => void
  now?: () => number
  timing?: Partial<{ heartbeatMs: number; refreshMs: number; batchMs: number; retryMs: number }>
}

type Peer = { channel: Channel; watching: boolean; events: unknown[]; failures: number; hello: boolean }

export function createRemoteLink(deps: LinkDependencies) {
  const now = deps.now ?? Date.now
  const timing = { heartbeatMs: HEARTBEAT_MS, refreshMs: REFRESH_MS, batchMs: BATCH_MS, retryMs: 1_000, ...deps.timing }
  const state: {
    identity?: RemoteIdentity
    loaded?: Promise<void>
    socket?: RemoteSocket
    opening?: boolean
    online: boolean
    status: RemoteState
    message?: string
    viewers: number
    attached: Set<string>
    peers: Map<string, Peer>
    heartbeat?: ReturnType<typeof setInterval>
    refresher?: ReturnType<typeof setInterval>
    flusher?: ReturnType<typeof setTimeout>
    retry?: ReturnType<typeof setTimeout>
    failures: number
    revokedOnce: boolean
    stream?: AbortController
    watching: boolean
    directories?: { at: number; value: Promise<ReadonlySet<string>> }
    tokens: number
    filled: number
    waiting: (() => void)[]
    stopped: boolean
  } = {
    online: false,
    status: "off",
    viewers: 0,
    attached: new Set(),
    peers: new Map(),
    failures: 0,
    revokedOnce: false,
    watching: false,
    tokens: BURST,
    filled: now(),
    waiting: [],
    stopped: false,
  }

  const turns = createRemoteTurns()
  const approvals = createPasskeyApprovals({ origin: deps.origin, now })
  const pairing = createRemotePairing({
    origin: deps.origin,
    identity: () => state.identity,
    addPhone: async (phone) => {
      const identity = state.identity
      if (!identity) throw new Error("Remote is not set up on this computer.")
      const phones = [...identity.phones.filter((item) => item.device !== phone.device), phone].slice(-MAX_PHONES)
      await save({ ...identity, phones })
    },
    send: (phone, envelope) => sendFrame(phone, envelope),
    computerName: deps.computerName,
    changed: () => {
      emit()
      // A pairing that ended with no phone paired has nothing left to connect for.
      void evaluate()
    },
    now,
  })

  const save = async (identity: RemoteIdentity) => {
    await deps.store.write(identity)
    state.identity = identity
  }

  const directories = () => {
    if (!state.directories || now() - state.directories.at > DIRECTORIES_MS)
      state.directories = {
        at: now(),
        value: deps.engine
          .request({ method: "GET", path: "/project", query: {} })
          .then((answer) => (answer.status === 200 ? projectDirectories(answer.body) : new Set<string>()))
          .catch(() => new Set<string>()),
      }
    return state.directories.value
  }

  const routes = createRemoteRoutes({
    engine: deps.engine.request,
    directories,
    approvals,
    credential: (phone) => state.identity?.phones.find((item) => item.device === phone)?.credential,
    saveCredential: async (phone, credential) => {
      const identity = state.identity
      if (!identity) return
      await save({
        ...identity,
        phones: identity.phones.map((item) => (item.device === phone ? { ...item, credential } : item)),
      })
    },
    turns,
  })

  const status = (): RemoteStatus => ({
    enabled: deps.enabled.get(),
    state: state.status,
    ...(state.message ? { message: state.message } : {}),
    phones: (state.identity?.phones ?? []).map((phone) => ({
      device: phone.device,
      name: phone.name,
      pairedAt: phone.pairedAt,
      connected: state.peers.has(phone.device),
      watching: Boolean(state.peers.get(phone.device)?.watching),
    })),
    limit: MAX_PHONES,
    viewers: state.viewers,
    pairing: pairing.status(),
  })

  const emit = () => deps.changed?.(status())

  const setStatus = (next: RemoteState, message?: string) => {
    state.status = next
    state.message = message
    emit()
  }

  // The relay averages 20 frames a second per connection; this stays under it, with a burst for answers.
  const refill = () => {
    const at = now()
    state.tokens = Math.min(BURST, state.tokens + ((at - state.filled) / 1_000) * FRAMES_PER_SECOND)
    state.filled = at
  }
  const take = async () => {
    refill()
    if (state.tokens >= 1 && state.waiting.length === 0) {
      state.tokens -= 1
      return
    }
    await new Promise<void>((resolve) => {
      state.waiting.push(resolve)
      if (state.waiting.length === 1) schedule()
    })
  }
  const schedule = () => {
    setTimeout(
      () => {
        refill()
        while (state.waiting.length && state.tokens >= 1) {
          state.tokens -= 1
          state.waiting.shift()!()
        }
        if (state.waiting.length) schedule()
      },
      Math.ceil(1_000 / FRAMES_PER_SECOND),
    )
  }

  async function sendFrame(phone: string, envelope: Uint8Array) {
    const socket = state.socket
    // With no phone attached the relay drops data frames, and closes a computer that keeps sending them.
    if (!socket || !state.online || state.viewers === 0) return
    await take()
    if (state.socket !== socket || socket.readyState !== 1) return
    socket.send(encodeFrame(FRAME.DATA, deviceBytes(phone), envelope))
  }

  const sendMessage = async (phone: string, message: unknown) => {
    const peer = state.peers.get(phone)
    if (!peer) return
    await sendFrame(phone, await peer.channel.seal(message))
  }

  // An answer larger than one frame goes in parts: base64url of the JSON's UTF-8 bytes, 40 KB at a time.
  const answer = async (phone: string, id: number, status: number, body: unknown) => {
    const text = JSON.stringify(body ?? null)
    const bytes = new TextEncoder().encode(text)
    if (bytes.byteLength <= CHUNK_BYTES) return sendMessage(phone, { t: "res", id, status, body: body ?? null })
    const parts = Math.ceil(bytes.byteLength / CHUNK_BYTES)
    for (let part = 0; part < parts; part++)
      await sendMessage(phone, {
        t: "res",
        id,
        status,
        part,
        parts,
        data: toBase64url(bytes.subarray(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES)),
      })
  }

  const watchers = () => [...state.peers.values()].filter((peer) => peer.watching).length

  const updateWatching = () => {
    const watching = state.viewers > 0 && watchers() > 0
    if (watching !== state.watching) {
      state.watching = watching
      deps.watchingChanged?.()
    }
    syncStream()
    emit()
  }

  // The engine's events are read while a phone watches, and while a turn a phone started has not ended (to know when
  // it does). Nothing is read otherwise.
  const syncStream = () => {
    const wanted = !state.stopped && (state.watching || turns.size > 0)
    if (wanted && !state.stream) {
      const controller = new AbortController()
      state.stream = controller
      void readEvents(controller).finally(() => {
        if (state.stream === controller) state.stream = undefined
        // A dropped stream is opened again while it is still wanted.
        if (!controller.signal.aborted)
          setTimeout(() => {
            if (!state.stopped) syncStream()
          }, timing.retryMs * 5)
      })
    }
    if (!wanted && state.stream) {
      state.stream.abort()
      state.stream = undefined
    }
  }

  const readEvents = async (controller: AbortController) => {
    try {
      for await (const event of deps.engine.events(controller.signal)) {
        turns.observe(event.payload)
        if (state.watching && STREAMED.has(event.payload.type)) await queueEvent(event)
        if (!state.watching && turns.size === 0) break
      }
    } catch (error) {
      if (!controller.signal.aborted) deps.log?.("remote: engine events stopped", { error: String(error) })
    }
    if (!state.watching && turns.size === 0) controller.abort()
  }

  const queueEvent = async (event: EngineEvent) => {
    if (!event.directory || !(await directories()).has(event.directory)) return
    const entry = { directory: event.directory, type: event.payload.type, properties: event.payload.properties }
    const text = JSON.stringify(entry)
    const value =
      new TextEncoder().encode(text).byteLength <= EVENT_BYTES
        ? entry
        : { directory: event.directory, type: entry.type, properties: summary(entry.properties), truncated: true }
    for (const peer of state.peers.values()) if (peer.watching) peer.events.push(value)
    if (!state.flusher) {
      const interval = timing.batchMs * Math.max(1, Math.ceil(watchers() / 3))
      state.flusher = setTimeout(() => void flush(), interval)
    }
  }

  const flush = async () => {
    state.flusher = undefined
    for (const [phone, peer] of state.peers) {
      if (!peer.watching || peer.events.length === 0) continue
      const events = peer.events.splice(0)
      // Batches stay inside one frame each.
      let batch: unknown[] = []
      let size = 0
      for (const event of events) {
        const length = new TextEncoder().encode(JSON.stringify(event)).byteLength
        if (batch.length && size + length > CHUNK_BYTES) {
          await sendMessage(phone, { t: "events", events: batch }).catch(() => {})
          batch = []
          size = 0
        }
        batch.push(event)
        size += length
      }
      if (batch.length) await sendMessage(phone, { t: "events", events: batch }).catch(() => {})
    }
  }

  const handleMessage = async (phone: string, peer: Peer, message: unknown) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return
    const input = message as Record<string, unknown>
    if (input.t === "hello") {
      const protocol = typeof input.protocol === "number" ? input.protocol : 0
      const minPeer = typeof input.minPeer === "number" ? input.minPeer : Infinity
      if (protocol < REMOTE_MIN_PHONE_PROTOCOL || REMOTE_PROTOCOL < minPeer) {
        await sendMessage(phone, { t: "update", side: protocol < REMOTE_MIN_PHONE_PROTOCOL ? "phone" : "desktop" })
        dropPeer(phone)
        return
      }
      peer.hello = true
      await sendMessage(phone, {
        t: "hello",
        protocol: REMOTE_PROTOCOL,
        minPeer: REMOTE_MIN_PHONE_PROTOCOL,
        name: deps.computerName().slice(0, 64),
      })
      return
    }
    if (!peer.hello) return
    if (input.t === "req" && typeof input.id === "number" && Number.isSafeInteger(input.id)) {
      const answered = await routes.handle(phone, input).catch(() => ({
        status: 500,
        body: { error: { code: "REMOTE_FAILED", message: "Vector on this computer could not do that." } },
      }))
      await answer(phone, input.id, answered.status, answered.body)
      // A turn the phone started is followed until its session is idle again.
      syncStream()
      return
    }
    if (input.t === "watch") {
      peer.watching = true
      updateWatching()
      return
    }
    if (input.t === "unwatch") {
      peer.watching = false
      peer.events = []
      updateWatching()
      return
    }
    if (input.t === "bye") dropPeer(phone)
  }

  const dropPeer = (phone: string) => {
    if (!state.peers.delete(phone)) return
    updateWatching()
  }

  const receive = async (phone: string, envelope: Uint8Array) => {
    const identity = state.identity
    if (!identity || envelope.byteLength === 0) return
    if (envelope[0] === ENVELOPE.PAIR) {
      await pairing.receive(phone, envelope)
      return
    }
    const paired = identity.phones.find((item) => item.device === phone)
    if (!paired) return
    if (envelope[0] === ENVELOPE.INIT) {
      const accepted = await computerAccept({
        computerPrivate: fromBase64url(identity.privateKey),
        peers: {
          computer: identity.device,
          computerKey: fromBase64url(identity.publicKey),
          phone: paired.device,
          phoneKey: fromBase64url(paired.key),
        },
        envelope,
      }).catch(() => undefined)
      if (!accepted) return
      state.peers.set(phone, { channel: accepted.channel, watching: false, events: [], failures: 0, hello: false })
      await sendFrame(phone, accepted.envelope)
      emit()
      return
    }
    if (envelope[0] !== ENVELOPE.DATA) return
    const peer = state.peers.get(phone)
    if (!peer) return
    const message = await peer.channel.open(envelope).catch(() => undefined)
    if (message === undefined) {
      peer.failures += 1
      if (peer.failures > 20) dropPeer(phone)
      return
    }
    await handleMessage(phone, peer, message)
  }

  const control = async (message: ServerMessage) => {
    if (message.t === "hello" || message.t === "peers") {
      state.viewers = message.viewers
      const phones = new Set(message.peers.filter((peer) => peer.role === "phone").map((peer) => peer.device))
      state.attached = phones
      for (const phone of [...state.peers.keys()]) if (!phones.has(phone)) state.peers.delete(phone)
      if (message.t === "hello") {
        state.revokedOnce = false
        state.failures = 0
        setStatus("online")
      }
      if (message.t === "peers" && message.refresh) await refresh()
      syncRefresher()
      updateWatching()
    }
  }

  // A phone arriving asks for a fresh ticket, and one is sent every four minutes while a phone stays attached, so this
  // computer's frames are never refused for a lapsed ticket.
  const syncRefresher = () => {
    if (state.viewers > 0 && !state.refresher) {
      state.refresher = setInterval(() => void refresh(), timing.refreshMs)
      return
    }
    if (state.viewers === 0 && state.refresher) {
      clearInterval(state.refresher)
      state.refresher = undefined
    }
  }

  const refresh = async () => {
    const socket = state.socket
    const identity = state.identity
    if (!socket || !identity) return
    const ticket = await mint(identity).catch(() => undefined)
    if (ticket && "ticket" in ticket && state.socket === socket && socket.readyState === 1)
      socket.send(JSON.stringify({ t: "refresh", ticket: ticket.ticket }))
  }

  type Minted = { ticket: string; url: string } | { refused: RemoteState; message?: string; retryMs: number }

  const mint = async (identity: RemoteIdentity): Promise<Minted> => {
    const token = await deps.token().catch(() => undefined)
    if (!token) return { refused: "signed-out", retryMs: 0 }
    const name = (deps.relayName?.() ?? "").slice(0, 64)
    const response = await deps
      .api(`${API}/ticket`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          role: "computer",
          device: identity.device,
          key: identity.publicKey,
          ...(name ? { name } : {}),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      })
      .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
    if (response instanceof Error) {
      if (response.name === "EgressBlocked") return { refused: "local-off", retryMs: 0 }
      return { refused: "unavailable", message: "Vector could not reach vectordev.ai.", retryMs: 60_000 }
    }
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
    if (!response.ok) {
      const error = body?.error as { code?: unknown; message?: unknown } | undefined
      const message = typeof error?.message === "string" ? error.message.slice(0, 300) : undefined
      if (response.status === 401) return { refused: "signed-out", ...(message ? { message } : {}), retryMs: 0 }
      if (response.status === 402 || response.status === 403)
        return { refused: "not-in-plan", ...(message ? { message } : {}), retryMs: 30 * 60_000 }
      return { refused: "unavailable", ...(message ? { message } : {}), retryMs: 10 * 60_000 }
    }
    if (typeof body?.ticket !== "string" || typeof body.url !== "string" || body.protocol !== RELAY_SUBPROTOCOL)
      return { refused: "unavailable", retryMs: 10 * 60_000 }
    let url: URL
    try {
      url = new URL(body.url)
    } catch {
      return { refused: "unavailable", retryMs: 10 * 60_000 }
    }
    const local = url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if ((url.protocol !== "wss:" && !local) || url.pathname !== "/v1/connect" || url.search || url.username)
      return { refused: "unavailable", retryMs: 10 * 60_000 }
    return { ticket: body.ticket, url: url.href }
  }

  const wanted = () => {
    if (state.stopped || !deps.enabled.get() || !state.identity) return false
    const pairingOpen = ["waiting", "confirm"].includes(pairing.status().state)
    return state.identity.phones.length > 0 || pairingOpen
  }

  const clearRetry = () => {
    if (state.retry) clearTimeout(state.retry)
    state.retry = undefined
  }

  const retryIn = (ms: number) => {
    clearRetry()
    if (ms <= 0) return
    state.retry = setTimeout(() => {
      state.retry = undefined
      void evaluate()
    }, ms)
  }

  const open = async () => {
    const identity = state.identity
    if (!identity || state.socket || state.opening) return
    state.opening = true
    setStatus("connecting")
    const minted = await mint(identity)
    state.opening = false
    if (state.socket) return
    if (!wanted()) return void setStatus(deps.enabled.get() ? "ready" : "off")
    if ("refused" in minted) {
      setStatus(minted.refused, minted.message)
      retryIn(minted.retryMs)
      return
    }
    if (!deps.allowed(minted.url)) {
      setStatus("local-off")
      return
    }
    let socket: RemoteSocket
    try {
      socket = deps.socket(minted.url, [RELAY_SUBPROTOCOL, minted.ticket])
    } catch {
      setStatus("unavailable", "Vector could not reach the Remote relay.")
      retryIn(backoff())
      return
    }
    socket.binaryType = "arraybuffer"
    state.socket = socket
    socket.onopen = () => {
      if (state.socket !== socket) return
      state.online = true
      state.heartbeat = setInterval(() => {
        if (socket.readyState === 1) socket.send(HEARTBEAT.request)
      }, timing.heartbeatMs)
    }
    socket.onmessage = (event) => {
      if (state.socket !== socket) return
      void onData(event.data).catch((error: unknown) => deps.log?.("remote: frame failed", { error: String(error) }))
    }
    socket.onerror = () => {}
    socket.onclose = (event) => {
      if (state.socket !== socket) return
      closed(event.code)
    }
  }

  const onData = async (data: unknown) => {
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
        : data instanceof Uint8Array
          ? data
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : undefined
    if (!bytes) return
    const frame = decodeFrame(bytes)
    if (!frame || frame.kind !== FRAME.DATA) return
    await receive(toBase64url(frame.device), frame.ciphertext.slice())
  }

  const backoff = () => Math.min(timing.retryMs * 2 ** state.failures, 5 * 60_000)

  const teardown = () => {
    if (state.heartbeat) clearInterval(state.heartbeat)
    if (state.refresher) clearInterval(state.refresher)
    if (state.flusher) clearTimeout(state.flusher)
    state.heartbeat = undefined
    state.refresher = undefined
    state.flusher = undefined
    state.socket = undefined
    state.online = false
    state.viewers = 0
    state.attached = new Set()
    state.peers.clear()
    updateWatching()
  }

  const closed = (code: number) => {
    teardown()
    if (!wanted()) {
      setStatus(deps.enabled.get() ? "ready" : "off")
      return
    }
    state.failures += 1
    if (code === CLOSE.REMOTE_REVOKED) {
      // A ticket minted in the same second as "Disconnect all" can be refused: ask for a new one once.
      if (!state.revokedOnce) {
        state.revokedOnce = true
        retryIn(timing.retryMs)
        setStatus("connecting")
        return
      }
      setStatus("revoked", "This computer was disconnected from Remote. Pair your phone again.")
      retryIn(30 * 60_000)
      return
    }
    if (code === CLOSE.REMOTE_PAUSED) return void (setStatus("paused"), retryIn(10 * 60_000))
    if (code === CLOSE.RELAY_OFF) return void (setStatus("unavailable"), retryIn(10 * 60_000))
    if (code === CLOSE.REMOTE_DEVICE_LIMIT) return void (setStatus("device-limit"), retryIn(30 * 60_000))
    if (code === CLOSE.REMOTE_FAIR_USE) return void (setStatus("fair-use"), retryIn(60 * 60_000))
    if (code === CLOSE.REPLACED) return void (setStatus("replaced"), retryIn(30 * 60_000))
    setStatus("connecting")
    retryIn(backoff())
  }

  const close = (code = 1000) => {
    const socket = state.socket
    teardown()
    try {
      socket?.close(code, "bye")
    } catch {}
  }

  const load = () => {
    state.loaded ??= deps.store
      .read()
      .then(decodeIdentity)
      .catch(() => undefined)
      .then((identity) => {
        if (identity) state.identity = identity
      })
    return state.loaded
  }

  const ensureIdentity = async () => {
    await load()
    if (!state.identity) await save(await newIdentity(now()))
    return state.identity!
  }

  const evaluate = async () => {
    await load()
    if (!wanted()) {
      clearRetry()
      if (state.socket) close()
      setStatus(deps.enabled.get() ? "ready" : "off")
      return
    }
    if (!state.socket) await open()
  }

  const apiPost = async (path: string) => {
    const token = await deps.token().catch(() => undefined)
    if (!token) return false
    const response = await deps
      .api(`${API}/${path}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      })
      .catch(() => undefined)
    return Boolean(response?.ok)
  }

  return {
    status,
    start: () => evaluate(),
    /** Looks again at whether to connect: after a sign-in, or a plan change. */
    refresh: () => evaluate(),
    /** Signed out of Vector: the connection closes until a sign-in. */
    signedOut() {
      clearRetry()
      pairing.cancel()
      close()
      if (deps.enabled.get()) setStatus("signed-out")
    },
    async setEnabled(value: boolean) {
      deps.enabled.set(value)
      if (value) await ensureIdentity()
      else pairing.cancel()
      await evaluate()
      return status()
    },
    /** A pairing offer for the QR code. Turns Remote on. */
    async startPairing() {
      deps.enabled.set(true)
      await ensureIdentity()
      const offer = pairing.start()
      await evaluate()
      return { ...offer, status: status() }
    },
    async confirmPairing(code?: string) {
      await pairing.confirm(code)
      await evaluate()
      return status()
    },
    cancelPairing() {
      pairing.cancel()
      void evaluate()
      return status()
    },
    /** Removes one phone from this computer. It can no longer open a connection here. */
    async unpair(device: string) {
      await load()
      const identity = state.identity
      if (!identity || typeof device !== "string") return status()
      await save({ ...identity, phones: identity.phones.filter((phone) => phone.device !== device) })
      approvals.forget(device)
      dropPeer(device)
      await evaluate()
      return status()
    },
    /**
     * "Disconnect all phones": a new identity, so no phone paired before can connect, then every relay connection of
     * the account closed and the old device's place freed.
     */
    async disconnectAll() {
      await load()
      const old = state.identity
      pairing.cancel()
      if (old) for (const phone of old.phones) approvals.forget(phone.device)
      close()
      await save(await newIdentity(now()))
      const killed = await apiPost("kill")
      if (old) await apiPost(`devices/${encodeURIComponent(old.device)}/revoke`)
      await evaluate()
      return { ...status(), killed }
    },
    /** Whether any of these sessions runs a turn a phone started (the app's auto-accept leaves those to a person). */
    isPhoneTurn(sessionIDs: unknown) {
      if (!Array.isArray(sessionIDs)) return false
      return turns.has(sessionIDs.filter((id): id is string => typeof id === "string").slice(0, 64))
    },
    /** Whether a phone is attached and watching; keep-awake holds the computer awake for busy sessions then. */
    watching: () => state.watching,
    /** The alert key and its id while a phone is paired (remote-notify.ts). */
    alertKey() {
      const identity = state.identity
      return identity && identity.phones.length > 0 ? { key: identity.alertKey, id: identity.alertKeyId } : undefined
    },
    phones: (): readonly PairedPhone[] => state.identity?.phones ?? [],
    stop() {
      state.stopped = true
      clearRetry()
      close()
      state.stream?.abort()
      state.stream = undefined
    },
  }
}

export type RemoteLink = ReturnType<typeof createRemoteLink>

/** What is left of an event too large to stream: the ids the phone needs to read it again. */
function summary(properties: unknown) {
  if (!properties || typeof properties !== "object") return {}
  const input = properties as Record<string, unknown>
  const pick = (value: unknown) => (typeof value === "string" && value.length <= 128 ? value : undefined)
  const info = (input.info ?? input.part ?? {}) as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of [
    ["sessionID", input.sessionID ?? info.sessionID],
    ["messageID", input.messageID ?? info.messageID ?? (input.info ? info.id : undefined)],
    ["partID", input.partID ?? (input.part ? info.id : undefined)],
    ["id", input.id],
  ] as const) {
    const picked = pick(value)
    if (picked) out[key] = picked
  }
  return out
}
