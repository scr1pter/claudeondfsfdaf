import { createHash } from "node:crypto"

/*
 * The small part of WebSocket (RFC 6455) the viewer proxy needs, server side: the handshake and frames. Client frames
 * must be masked, messages are capped, and control frames are answered. No extension is negotiated.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const KEY = /^[A-Za-z0-9+/]{22}==$/
export const MAX_MESSAGE = 1024 * 1024

export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const

export function acceptKey(key: string) {
  return createHash("sha1").update(key + GUID).digest("base64")
}

/**
 * Checks an upgrade request; answers the Sec-WebSocket-Accept value, or undefined when it is not a WebSocket request
 * from the page's own origin.
 */
export function checkUpgrade(headers: Readonly<Record<string, string | string[] | undefined>>, origin: (host: string) => boolean) {
  const one = (name: string) => {
    const value = headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  if (one("upgrade")?.toLowerCase() !== "websocket") return undefined
  if (!one("connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade")) return undefined
  if (one("sec-websocket-version") !== "13") return undefined
  const key = one("sec-websocket-key")
  if (!key || !KEY.test(key)) return undefined
  const sent = one("origin")
  if (!sent || !origin(sent)) return undefined
  return acceptKey(key)
}

/** One server frame (servers never mask). */
export function encodeFrame(opcode: number, payload: Uint8Array = new Uint8Array()) {
  const length = payload.length
  const header = length < 126 ? 2 : length < 65_536 ? 4 : 10
  const frame = Buffer.alloc(header + length)
  frame[0] = 0x80 | opcode
  if (length < 126) frame[1] = length
  else if (length < 65_536) {
    frame[1] = 126
    frame.writeUInt16BE(length, 2)
  } else {
    frame[1] = 127
    frame.writeBigUInt64BE(BigInt(length), 2)
  }
  frame.set(payload, header)
  return frame
}

export type Message = { opcode: number; data: Buffer }

/** Reads client frames into whole messages. Throws on anything a conforming client would not send. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode = 0
  private fragmentSize = 0

  push(chunk: Buffer): Message[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const messages: Message[] = []
    for (;;) {
      if (this.buffer.length < 2) break
      const first = this.buffer[0]!
      const second = this.buffer[1]!
      if (first & 0x70) throw new Error("reserved bits set")
      if (!(second & 0x80)) throw new Error("client frames must be masked")
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) break
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) break
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE)) throw new Error("frame too large")
        length = Number(big)
        offset = 10
      }
      if (length > MAX_MESSAGE) throw new Error("frame too large")
      if (this.buffer.length < offset + 4 + length) break
      const mask = this.buffer.subarray(offset, offset + 4)
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
      this.buffer = this.buffer.subarray(offset + 4 + length)
      if (opcode >= 8) {
        if (!fin || length > 125) throw new Error("bad control frame")
        messages.push({ opcode, data: payload })
        continue
      }
      if (opcode === OPCODE.continuation) {
        if (!this.fragmentOpcode) throw new Error("unexpected continuation")
      } else {
        if (opcode !== OPCODE.text && opcode !== OPCODE.binary) throw new Error("unknown opcode")
        if (this.fragmentOpcode) throw new Error("interleaved message")
        this.fragmentOpcode = opcode
      }
      this.fragmentSize += payload.length
      if (this.fragmentSize > MAX_MESSAGE) throw new Error("message too large")
      this.fragments.push(payload)
      if (fin) {
        messages.push({ opcode: this.fragmentOpcode, data: Buffer.concat(this.fragments) })
        this.fragments = []
        this.fragmentOpcode = 0
        this.fragmentSize = 0
      }
    }
    return messages
  }
}
