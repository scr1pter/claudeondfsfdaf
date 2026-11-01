import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Computer } from "@vectordevai/schema/computer"
import { encodeFrame, FrameDecoder } from "./computer-protocol"

// D14: only byte streams in memory. No helper process, real screen, input or OS permissions are used.

const HEADER = {
  id: 2,
  ok: true,
  captureId: "capture_1",
  width: 2,
  height: 1,
  origin: { x: -120, y: 0 },
  imageScale: 1,
  displayId: "display_1",
  capturedAtMs: 1_000,
  masked: [],
  hash: "0123456789abcdef",
  imageBytes: 4,
} as const

function collect(maxBytes?: number) {
  const messages: unknown[] = []
  const images: { header: Computer.CaptureHeader & { id: number; ok: true }; bytes: Uint8Array }[] = []
  const errors: { code: Computer.ComputerErrorCode; error: string }[] = []
  const decoder = new FrameDecoder({
    maxBytes,
    onMessage: (value) => messages.push(value),
    onImage: (header, bytes) => images.push({ header, bytes }),
    onError: (code, error) => errors.push({ code, error }),
  })
  return { decoder, messages, images, errors }
}

function raw(bytes: Uint8Array) {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(bytes.byteLength, 0)
  return Buffer.concat([header, bytes])
}

describe("helper protocol framing", () => {
  test("round-trips JSON with a UTF-8 byte length and big-endian prefix", () => {
    const frame = encodeFrame({ id: 1, op: "clipboard.write", text: "ß猫🙂" })
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4)
    expect([...frame.subarray(0, 3)]).toEqual([0, 0, 0])
    const got = collect()
    got.decoder.push(frame)
    got.decoder.end()
    expect(got.messages).toEqual([{ id: 1, op: "clipboard.write", text: "ß猫🙂" }])
    expect(got.errors).toEqual([])
  })

  test("accepts every prefix/body boundary, including split UTF-8 characters", () => {
    const value = { id: 1, ok: true, text: "猫🙂" }
    const frame = encodeFrame(value)
    for (let cut = 0; cut <= frame.byteLength; cut++) {
      const got = collect()
      got.decoder.push(frame.subarray(0, cut))
      if (cut < frame.byteLength) expect(got.messages).toEqual([])
      got.decoder.push(frame.subarray(cut))
      got.decoder.end()
      expect(got.messages).toEqual([value])
      expect(got.errors).toEqual([])
    }
  })

  test("handles one-byte chunks and multiple adjacent messages", () => {
    const got = collect()
    const frame = Buffer.concat([encodeFrame({ id: 1, ok: true }), encodeFrame({ event: "locked", locked: true })])
    for (const byte of frame) got.decoder.push(Uint8Array.of(byte))
    expect(got.messages).toEqual([
      { id: 1, ok: true },
      { event: "locked", locked: true },
    ])
    expect(got.errors).toEqual([])
  })

  test("copies partial input rather than retaining a caller's mutable byte view", () => {
    const got = collect()
    const frame = encodeFrame({ id: 1, ok: true })
    const first = Buffer.from(frame.subarray(0, 8))
    got.decoder.push(first)
    first.fill(0)
    got.decoder.push(frame.subarray(8))
    expect(got.messages).toEqual([{ id: 1, ok: true }])
  })

  test("pairs a capture header with exactly one raw binary frame", () => {
    const got = collect()
    const bytes = Uint8Array.of(0, 255, 192, 128)
    got.decoder.push(encodeFrame(HEADER))
    expect(got.messages).toEqual([])
    expect(got.images).toEqual([])
    const frame = encodeFrame(bytes)
    got.decoder.push(frame.subarray(0, 5))
    expect(got.images).toEqual([])
    got.decoder.push(Buffer.concat([frame.subarray(5), encodeFrame({ id: 3, ok: true })]))
    expect(got.images).toEqual([{ header: HEADER, bytes: Buffer.from(bytes) }])
    expect(got.messages).toEqual([{ id: 3, ok: true }])
    expect(got.errors).toEqual([])
  })

  test("never treats an image whose bytes resemble JSON as a protocol message", () => {
    const got = collect()
    const bytes = Buffer.from('{"id":9,"ok":true}')
    got.decoder.push(Buffer.concat([encodeFrame({ ...HEADER, imageBytes: bytes.length }), encodeFrame(bytes)]))
    expect(got.images[0]?.bytes).toEqual(bytes)
    expect(got.messages).toEqual([])
    expect(got.errors).toEqual([])
  })

  test("rejects an image's wrong binary length and can resume at the next frame", () => {
    const got = collect()
    got.decoder.push(
      Buffer.concat([encodeFrame(HEADER), encodeFrame(Uint8Array.of(1, 2)), encodeFrame({ id: 3, ok: true })]),
    )
    expect(got.images).toEqual([])
    expect(got.errors.map((error) => error.code)).toEqual(["failed"])
    expect(got.messages).toEqual([{ id: 3, ok: true }])
  })

  test("rejects malformed image headers without leaking a header as an ordinary reply", () => {
    for (const changed of [
      { id: 0 },
      { ok: false },
      { imageBytes: 0 },
      { imageBytes: 1.5 },
      { width: 0 },
      { captureId: undefined },
    ]) {
      const got = collect()
      expect(() => got.decoder.push(encodeFrame({ ...HEADER, ...changed }))).not.toThrow()
      expect(got.errors.map((error) => error.code)).toEqual(["failed"])
      expect(got.messages).toEqual([])
      expect(got.images).toEqual([])
    }
  })

  test("reports an oversized body from its prefix and discards it across chunks", () => {
    const got = collect(32)
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(40)
    got.decoder.push(prefix)
    expect(got.errors.map((error) => error.code)).toEqual(["frame_too_large"])
    got.decoder.push(Buffer.alloc(19, 123))
    got.decoder.push(Buffer.concat([Buffer.alloc(21, 125), encodeFrame({ id: 1, ok: true })]))
    got.decoder.end()
    expect(got.messages).toEqual([{ id: 1, ok: true }])
    expect(got.errors).toHaveLength(1)
  })

  test("a configured larger limit never raises the hard 16 MiB cap", () => {
    const got = collect(Computer.LIMITS.helperFrameBytes * 2)
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(Computer.LIMITS.helperFrameBytes + 1)
    expect(() => got.decoder.push(prefix)).not.toThrow()
    expect(got.errors.map((error) => error.code)).toEqual(["frame_too_large"])
  })

  test("accepts the exact configured byte limit", () => {
    const body = Buffer.from('{"id":1,"ok":true}')
    const got = collect(body.byteLength)
    got.decoder.push(raw(body))
    got.decoder.end()
    expect(got.messages).toEqual([{ id: 1, ok: true }])
    expect(got.errors).toEqual([])
  })

  test("rejects oversized image declarations before buffering any image bytes", () => {
    const got = collect()
    got.decoder.push(encodeFrame({ ...HEADER, imageBytes: Computer.LIMITS.helperFrameBytes + 1 }))
    expect(got.errors.map((error) => error.code)).toEqual(["frame_too_large"])
    expect(got.images).toEqual([])
  })

  test("malformed JSON and invalid UTF-8 report fixed errors and never throw", () => {
    const got = collect()
    const bodies = [Buffer.from('{"secret":"do-not-echo"'), Buffer.from([0xc0, 0xaf]), Buffer.from('\uFEFF{"id":1}')]
    for (const body of bodies) expect(() => got.decoder.push(raw(body))).not.toThrow()
    expect(got.errors).toHaveLength(3)
    expect(got.errors.every((error) => error.code === "failed")).toBe(true)
    expect(got.errors.some((error) => error.error.includes("do-not-echo"))).toBe(false)
    got.decoder.push(encodeFrame({ id: 1, ok: false, code: "failed", error: "No app" }))
    expect(got.messages).toEqual([{ id: 1, ok: false, code: "failed", error: "No app" }])
  })

  test("an empty frame is an error and does not consume the following message", () => {
    const got = collect()
    got.decoder.push(Buffer.concat([Buffer.alloc(4), encodeFrame({ id: 1, ok: true })]))
    expect(got.errors.map((error) => error.code)).toEqual(["failed"])
    expect(got.messages).toEqual([{ id: 1, ok: true }])
  })

  test("EOF reports an incomplete prefix, body or image once", () => {
    const frame = encodeFrame({ id: 1, ok: true })
    for (const partial of [frame.subarray(0, 2), frame.subarray(0, 8), encodeFrame(HEADER)]) {
      const got = collect()
      got.decoder.push(partial)
      got.decoder.end()
      got.decoder.end()
      got.decoder.push(frame)
      expect(got.errors.map((error) => error.code)).toEqual(["failed"])
      expect(got.messages).toEqual([])
      expect(got.images).toEqual([])
    }
  })

  test("closing an empty or complete channel is clean and final", () => {
    const got = collect()
    got.decoder.end()
    got.decoder.push(encodeFrame({ id: 1, ok: true }))
    expect(got.messages).toEqual([])
    expect(got.errors).toEqual([])
  })

  test("outbound bodies honor the hard byte cap", () => {
    expect(() => encodeFrame(Buffer.alloc(Computer.LIMITS.helperFrameBytes + 1))).toThrow(RangeError)
    const frame = encodeFrame(Buffer.alloc(Computer.LIMITS.helperFrameBytes))
    expect(frame.readUInt32BE(0)).toBe(Computer.LIMITS.helperFrameBytes)
    expect(() => encodeFrame(undefined)).toThrow(TypeError)
  })

  test("configured frame limits must be positive safe integers", () => {
    for (const maxBytes of [0, -1, 1.5, NaN, Infinity]) expect(() => collect(maxBytes)).toThrow(RangeError)
  })
})
