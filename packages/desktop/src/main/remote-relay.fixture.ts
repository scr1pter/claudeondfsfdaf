import { CLOSE, FRAME, HEARTBEAT, decodeFrame, encodeFrame, type Peer } from "@vectordevai/relay/protocol"
import { deviceBytes, toBase64url } from "./remote-crypto"

// Test fixture (WP A42): an in-memory Remote relay that the real desktop link (remote-link.ts) and the real phone
// client (packages/app/src/phone/remote/client.ts) both connect to. It behaves as packages/relay does on the wire: the
// handshake's `hello` with the other side's online devices and the viewer count, `peers` when they change (with
// `refresh` when a phone arrives), `ping`/`pong`, and data frames passed on byte for byte with the target's id swapped
// for the sender's. A ticket here is `vt1.<role>.<device>`, minted by the tests' fake API. Everything any side sent is
// kept, so a test can check the relay never saw plaintext.

export type RelaySocket = {
  readyState: number
  binaryType: string
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

type Connection = { role: "computer" | "phone"; device: string; socket: RelaySocket; key?: string }

export function ticketFor(role: "computer" | "phone", device: string) {
  return `vt1.${role}.${device}`
}

export function createMemoryRelay() {
  const connections = new Map<string, Connection>()
  const seen: Uint8Array[] = []
  const texts: string[] = []
  const keys = new Map<string, string>()
  const revoked = new Set<string>()

  const peersOf = (role: "computer" | "phone"): Peer[] =>
    [...connections.values()]
      .filter((item) => item.role !== role)
      .map((item) => ({
        device: item.device,
        role: item.role,
        name: item.role === "computer" ? "Mac" : "Phone",
        ...(item.key ? { key: item.key } : {}),
      }))
  const viewers = () => [...connections.values()].filter((item) => item.role === "phone").length

  const deliver = (connection: Connection, message: unknown) => {
    queueMicrotask(() => connection.socket.onmessage?.({ data: JSON.stringify(message) }))
  }

  const announce = (changed: "computer" | "phone") => {
    for (const other of connections.values())
      if (other.role !== changed)
        deliver(other, {
          t: "peers",
          peers: peersOf(other.role),
          viewers: viewers(),
          ...(changed === "phone" && other.role === "computer" ? { refresh: true } : {}),
        })
  }

  const leave = (connection: Connection, code: number) => {
    if (connections.get(connection.device) !== connection) return
    connections.delete(connection.device)
    connection.socket.readyState = 3
    queueMicrotask(() => connection.socket.onclose?.({ code }))
    announce(connection.role)
  }

  return {
    seen,
    texts,
    /** Registers the static key a computer's ticket carries, as the relay lists it in `peers`. */
    key(device: string, key: string) {
      keys.set(device, key)
    },
    /** A WebSocket as each side's `socket(url, protocols)` dependency makes one. */
    socket(url: string, protocols: string[]): RelaySocket {
      const ticket = protocols[1] ?? ""
      const [, role, device] = ticket.split(".") as [string, "computer" | "phone", string]
      const socket: RelaySocket = {
        readyState: 0,
        binaryType: "blob",
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(data) {
          if (socket.readyState !== 1) return
          const connection = connections.get(device)
          if (!connection || connection.socket !== socket) return
          if (typeof data === "string") {
            texts.push(data)
            if (data === HEARTBEAT.request) queueMicrotask(() => socket.onmessage?.({ data: HEARTBEAT.response }))
            return
          }
          const bytes = new Uint8Array(data)
          seen.push(bytes)
          const frame = decodeFrame(bytes)
          if (!frame || frame.kind !== FRAME.DATA) return
          const target = connections.get(toBase64url(frame.device))
          if (!target || target.role === connection.role) return
          // The relay drops a computer's frames while no phone is attached.
          if (connection.role === "computer" && viewers() === 0) return
          const out = encodeFrame(FRAME.DATA, deviceBytes(device), frame.ciphertext.slice())
          queueMicrotask(() => target.socket.onmessage?.({ data: out.buffer }))
        },
        close(code = 1000) {
          const connection = connections.get(device)
          if (connection?.socket === socket) leave(connection, code)
          else socket.readyState = 3
        },
      }
      if (!url.endsWith("/v1/connect") || protocols[0] !== "vector.v1" || !role || !device) {
        queueMicrotask(() => socket.onclose?.({ code: CLOSE.PROTOCOL }))
        return socket
      }
      queueMicrotask(() => {
        // A revoked device is accepted, then closed at once (a browser cannot read a handshake's HTTP status).
        if (revoked.has(device)) {
          socket.readyState = 3
          socket.onclose?.({ code: CLOSE.REMOTE_REVOKED })
          return
        }
        const previous = connections.get(device)
        if (previous) leave(previous, CLOSE.REPLACED)
        const connection: Connection = { role, device, socket, ...(keys.get(device) ? { key: keys.get(device) } : {}) }
        connections.set(device, connection)
        socket.readyState = 1
        socket.onopen?.({})
        deliver(connection, { t: "hello", v: 1, role, device, exp: 0, peers: peersOf(role), viewers: viewers() })
        announce(role)
      })
      return socket
    },
    /** Closes every connection of the account, as `kill` does. */
    kill() {
      for (const connection of [...connections.values()]) leave(connection, CLOSE.REMOTE_REVOKED)
    },
    /** Refuses a device from now on, as `revoke-device` does. */
    revoke(device: string) {
      revoked.add(device)
    },
    /** Closes one device's connection with a relay close code. */
    drop(device: string, code: number) {
      const connection = connections.get(device)
      if (connection) leave(connection, code)
    },
    online: (device: string) => connections.has(device),
    viewers,
  }
}

export type MemoryRelay = ReturnType<typeof createMemoryRelay>
