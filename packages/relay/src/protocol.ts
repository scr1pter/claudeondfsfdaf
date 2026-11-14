// What a Remote client (the desktop, A41; the phone app, A42) and the relay say to each other. Pure: no runtime APIs,
// so a client may import it as `@vectordevai/relay/protocol`.
//
// Connecting: open `wss://<relay>/v1/connect` offering two subprotocols, `vector.v1` and the ticket the API minted
// (`vt1.…`, see ticket.ts). The relay answers with `vector.v1` only, so the ticket never comes back. A ticket is good for
// one connection.
//
// Heartbeat: every 25 s send the text `ping`; the runtime answers `pong` without waking the relay. A connection silent
// for 75 s is closed.
//
// Data: binary frames, at most 64 KiB and 20 a second on average.
//
//   byte 0       kind: 0x01 data (0x02 job.offer is reserved; a client may not send it)
//   bytes 1-16   the other device's id: the target when sending, the sender when receiving
//   bytes 17-    the end-to-end ciphertext, passed on byte for byte
//
// A phone may send only to a computer and a computer only to a phone of the same account. The relay never reads the
// ciphertext, and drops a frame when the target is not connected. A computer that keeps sending with no viewer
// attached is closed.
//
// Control: JSON text frames. The client sends `{t:"refresh", ticket}` (a new ticket for the same device, before the
// current one expires; a viewer is closed a minute after expiry, a computer's frames are dropped until it refreshes) and
// `{t:"presence"}`. The relay sends `hello` on connect, `peers` whenever the other side's devices come or go,
// `refreshed`, and `error` notices (at most one a second).
//
// Idle: a phone that sends no data frame for 30 minutes is closed. Heartbeats, refreshes and presence queries are not
// activity, so a phone app sends data only when its user does something.

export const RELAY_SUBPROTOCOL = "vector.v1"
export const CONNECT_PATH = "/v1/connect"
export const HEARTBEAT = { request: "ping", response: "pong" } as const

export const FRAME = { DATA: 0x01, JOB_OFFER: 0x02 } as const
export const DEVICE_BYTES = 16
export const FRAME_HEADER_BYTES = 1 + DEVICE_BYTES

/** Close codes. 1009 is the standard "message too big"; the rest are the relay's own. */
export const CLOSE = {
  RELAY_OFF: 4000,
  REMOTE_PAUSED: 4001,
  REMOTE_REVOKED: 4002,
  REMOTE_DEVICE_LIMIT: 4003,
  REMOTE_FAIR_USE: 4004,
  TICKET_EXPIRED: 4005,
  IDLE: 4006,
  REPLACED: 4007,
  NO_VIEWER: 4008,
  TOO_FAST: 4009,
  PROTOCOL: 4010,
  STALE: 4011,
  TOO_LARGE: 1009,
} as const
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE]

/** The close reason sent with each code: the code's name, never anything about the account. */
export const CLOSE_REASON: Readonly<Record<CloseCode, string>> = Object.fromEntries(
  Object.entries(CLOSE).map(([name, code]) => [code, name]),
) as Record<CloseCode, string>

export type DeviceRole = "computer" | "phone"
export type Peer = { device: string; role: DeviceRole; name?: string; key?: string }

export type ServerMessage =
  | { t: "hello"; v: 1; role: DeviceRole; device: string; exp: number; peers: Peer[]; viewers: number }
  | { t: "peers"; peers: Peer[]; viewers: number; refresh?: true }
  | { t: "refreshed"; exp: number }
  | { t: "error"; code: NoticeCode }

export type ClientMessage = { t: "refresh"; ticket: string } | { t: "presence" }

export type NoticeCode =
  | "ticket-invalid"
  | "ticket-expired"
  | "too-fast"
  | "no-viewer"
  | "no-peer"
  | "reserved"
  | "bad-frame"
  | "unknown"

/** A device id is 16 random bytes in unpadded base64url (22 characters). */
export const DEVICE_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID.test(value)
}

/** Builds a frame: kind, the 16-byte device id, then the ciphertext unchanged. */
export function encodeFrame(kind: number, device: Uint8Array, ciphertext: Uint8Array): Uint8Array<ArrayBuffer> {
  if (device.byteLength !== DEVICE_BYTES) throw new Error("A device id is 16 bytes.")
  const frame = new Uint8Array(FRAME_HEADER_BYTES + ciphertext.byteLength)
  frame[0] = kind
  frame.set(device, 1)
  frame.set(ciphertext, FRAME_HEADER_BYTES)
  return frame
}

/** Splits a frame, or undefined when it is shorter than its header. The parts are views into `frame`. */
export function decodeFrame(frame: Uint8Array) {
  if (frame.byteLength < FRAME_HEADER_BYTES) return undefined
  return {
    kind: frame[0]!,
    device: frame.subarray(1, FRAME_HEADER_BYTES),
    ciphertext: frame.subarray(FRAME_HEADER_BYTES),
  }
}
