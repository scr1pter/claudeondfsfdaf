/*
 * The viewer proxy's reading of what a viewer sends to the VNC server (RFB 3.8, client to server). The proxy, not the
 * viewer page, decides what reaches the computer: a "view" connection's keyboard, pointer and clipboard messages are
 * dropped, so a modified page still cannot type or click. Only the 3.8 handshake with no VNC password is accepted (the
 * VNC server is a Unix socket only the proxy can reach; the viewer token is the credential), the shared flag is forced
 * on so one viewer cannot push another off, and any message the proxy does not know ends the connection.
 */

export const VERSION = "RFB 003.008\n"
const SECURITY_NONE = 1
const MAX_ENCODINGS = 64
const MAX_CUT_TEXT = 1024 * 1024

export const MESSAGE = {
  setPixelFormat: 0,
  setEncodings: 2,
  updateRequest: 3,
  key: 4,
  pointer: 5,
  cutText: 6,
} as const

export class RfbError extends Error {}

type Phase = "version" | "security" | "init" | "messages"

/** Filters one viewer's bytes. `control()` says, at each message, whether this viewer may give input right now. */
export class ClientFilter {
  private phase: Phase = "version"
  private buffer: Buffer = Buffer.alloc(0)
  /** Input messages dropped so far (a viewer in view mode that keeps sending them). */
  dropped = 0

  constructor(private readonly control: () => boolean) {}

  /** Bytes from the viewer; answers what may go on to the VNC server. */
  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const out: Buffer[] = []
    for (;;) {
      const message = this.next()
      if (!message) break
      if (message.length) out.push(message)
    }
    return out
  }

  /** The next whole unit, an empty buffer for one that is dropped, or undefined when more bytes are needed. */
  private next(): Buffer | undefined {
    const b = this.buffer
    switch (this.phase) {
      case "version": {
        if (b.length < 12) return undefined
        if (b.subarray(0, 12).toString("latin1") !== VERSION) throw new RfbError("only RFB 3.8 is accepted")
        this.phase = "security"
        return this.take(12)
      }
      case "security": {
        if (b.length < 1) return undefined
        if (b[0] !== SECURITY_NONE) throw new RfbError("only the no-password security type is accepted")
        this.phase = "init"
        return this.take(1)
      }
      case "init": {
        if (b.length < 1) return undefined
        this.take(1)
        this.phase = "messages"
        // Shared: a new viewer never disconnects the others.
        return Buffer.from([1])
      }
      case "messages":
        return this.message()
    }
  }

  private message(): Buffer | undefined {
    const b = this.buffer
    if (b.length < 1) return undefined
    const type = b[0]!
    switch (type) {
      case MESSAGE.setPixelFormat:
        return b.length < 20 ? undefined : this.take(20)
      case MESSAGE.setEncodings: {
        if (b.length < 4) return undefined
        const count = b.readUInt16BE(2)
        if (count > MAX_ENCODINGS) throw new RfbError("too many encodings")
        return b.length < 4 + 4 * count ? undefined : this.take(4 + 4 * count)
      }
      case MESSAGE.updateRequest:
        return b.length < 10 ? undefined : this.take(10)
      case MESSAGE.key:
        return b.length < 8 ? undefined : this.input(this.take(8))
      case MESSAGE.pointer:
        return b.length < 6 ? undefined : this.input(this.take(6))
      case MESSAGE.cutText: {
        if (b.length < 8) return undefined
        const length = b.readUInt32BE(4)
        if (length > MAX_CUT_TEXT) throw new RfbError("clipboard text too large")
        return b.length < 8 + length ? undefined : this.input(this.take(8 + length))
      }
      default:
        throw new RfbError(`unknown message ${type}`)
    }
  }

  private input(message: Buffer) {
    if (this.control()) return message
    this.dropped++
    return Buffer.alloc(0)
  }

  private take(length: number) {
    const part = Buffer.from(this.buffer.subarray(0, length))
    this.buffer = this.buffer.subarray(length)
    return part
  }
}
