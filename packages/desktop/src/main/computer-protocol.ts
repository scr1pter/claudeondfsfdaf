import { Buffer, isUtf8 } from "node:buffer"
import { Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeImage = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    ok: Schema.Literal(true),
    ...Computer.CaptureHeader.fields,
  }),
)

type ImageHeader = Computer.CaptureHeader & { id: number; ok: true }

type DecoderOptions = {
  onMessage: (value: unknown) => void
  onImage: (header: ImageHeader, bytes: Uint8Array) => void
  onError: (code: Computer.ComputerErrorCode, error: string) => void
  maxBytes?: number
}

/** Helper protocol v1: one big-endian length and one JSON or binary body. */
export function encodeFrame(value: unknown | Uint8Array): Buffer {
  const body = value instanceof Uint8Array ? value : JSON.stringify(value)
  if (body === undefined) throw new TypeError("A helper frame must contain JSON or bytes.")
  const length = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength
  if (length > Computer.LIMITS.helperFrameBytes) throw new RangeError("The helper frame is too large.")
  const frame = Buffer.allocUnsafe(4 + length)
  frame.writeUInt32BE(length, 0)
  if (typeof body === "string") frame.write(body, 4, "utf8")
  else frame.set(body, 4)
  return frame
}

/**
 * Buffers at most one bounded body. Oversized bodies are discarded as they arrive, without an allocation for the
 * declared length. A capture's JSON header is held until exactly its one binary frame arrives; binary bytes never
 * pass through UTF-8 or JSON parsing. The supervisor validates ordinary messages against their request's schema.
 */
export class FrameDecoder {
  private readonly prefix = Buffer.allocUnsafe(4)
  private readonly maxBytes: number
  private readonly options: DecoderOptions
  private prefixRead = 0
  private body: Buffer | undefined
  private bodyRead = 0
  private skip = 0
  private image: ImageHeader | undefined
  private ended = false

  constructor(options: DecoderOptions) {
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1))
      throw new RangeError("The helper frame limit must be a positive integer.")
    this.options = options
    this.maxBytes = Math.min(options.maxBytes ?? Computer.LIMITS.helperFrameBytes, Computer.LIMITS.helperFrameBytes)
  }

  push(chunk: Uint8Array): void {
    if (this.ended) return
    let offset = 0
    while (offset < chunk.byteLength && !this.ended) {
      if (this.skip) {
        const used = Math.min(this.skip, chunk.byteLength - offset)
        this.skip -= used
        offset += used
        continue
      }
      if (!this.body) {
        const used = Math.min(4 - this.prefixRead, chunk.byteLength - offset)
        this.prefix.set(chunk.subarray(offset, offset + used), this.prefixRead)
        this.prefixRead += used
        offset += used
        if (this.prefixRead < 4) return
        const length = this.prefix.readUInt32BE(0)
        this.prefixRead = 0
        if (length > this.maxBytes) {
          this.skip = length
          this.image = undefined
          this.options.onError("frame_too_large", "The helper frame exceeds its byte limit.")
          continue
        }
        if (this.image && length !== this.image.imageBytes) {
          this.skip = length
          this.image = undefined
          this.options.onError("failed", "The helper image length does not match its header.")
          continue
        }
        if (!length) {
          this.options.onError("failed", "The helper frame is empty.")
          continue
        }
        this.body = Buffer.allocUnsafe(length)
        this.bodyRead = 0
      }
      const used = Math.min(this.body.byteLength - this.bodyRead, chunk.byteLength - offset)
      this.body.set(chunk.subarray(offset, offset + used), this.bodyRead)
      this.bodyRead += used
      offset += used
      if (this.bodyRead < this.body.byteLength) return
      const body = this.body
      this.body = undefined
      this.bodyRead = 0
      this.deliver(body)
    }
  }

  /** EOF is final, including when the helper left a length, body or image pair incomplete. */
  end(): void {
    if (this.ended) return
    this.ended = true
    const incomplete = this.prefixRead > 0 || this.body !== undefined || this.skip > 0 || this.image !== undefined
    this.body = undefined
    this.image = undefined
    this.prefixRead = 0
    this.bodyRead = 0
    this.skip = 0
    if (incomplete) this.options.onError("failed", "The helper channel ended with an incomplete frame.")
  }

  private deliver(body: Buffer): void {
    if (this.image) {
      const image = this.image
      this.image = undefined
      this.options.onImage(image, body)
      return
    }
    if (!isUtf8(body)) {
      this.options.onError("failed", "The helper frame is not UTF-8 JSON.")
      return
    }
    const decoded = decodeJson(body.toString("utf8"))
    if (decoded._tag === "None") {
      this.options.onError("failed", "The helper frame is not valid JSON.")
      return
    }
    const value = decoded.value
    if (typeof value !== "object" || value === null || !("imageBytes" in value)) {
      this.options.onMessage(value)
      return
    }
    if (typeof value.imageBytes === "number" && value.imageBytes > this.maxBytes) {
      this.options.onError("frame_too_large", "The helper image exceeds its byte limit.")
      return
    }
    const image = decodeImage(value)
    if (image._tag === "None") {
      this.options.onError("failed", "The helper image header is invalid.")
      return
    }
    this.image = image.value
  }
}
