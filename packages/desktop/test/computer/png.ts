import { deflateSync, inflateSync } from "node:zlib"

/**
 * PNG encoding for the fake Vector Hands helper (C1): 8-bit RGBA, one IDAT, filter 0 on every scanline. `decodePng`
 * reads exactly what `encodePng` writes, for tests. `node:` APIs only, so the fake can run under Node.
 */

export interface Image {
  readonly width: number
  readonly height: number
  /** width * height * 4 bytes, row-major, top-left first. */
  readonly rgba: Uint8Array
}

export interface Budget {
  readonly maxWidth: number
  readonly maxHeight: number
  readonly maxPixels: number
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

const CRC_TABLE = Array.from({ length: 256 }, (_, index) =>
  Array.from({ length: 8 }).reduce<number>((value) => (value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1), index),
)

function crc32(bytes: Uint8Array) {
  const value = bytes.reduce((crc, byte) => CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8), 0xffffffff)
  return (value ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "latin1")
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

export function encodePng(image: Image): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y++)
    raw.set(image.rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

export function decodePng(bytes: Uint8Array): Image {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!data.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG")
  const chunks = new Map<string, Buffer[]>()
  for (let offset = 8; offset < data.length; ) {
    const length = data.readUInt32BE(offset)
    const type = data.toString("latin1", offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (data.readUInt32BE(offset + 8 + length) !== crc32(data.subarray(offset + 4, offset + 8 + length)))
      throw new Error(`Bad ${type} checksum`)
    chunks.set(type, [...(chunks.get(type) ?? []), body])
    offset += 12 + length
  }
  const header = chunks.get("IHDR")?.[0]
  if (!header || !chunks.has("IEND")) throw new Error("Incomplete PNG")
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  if (!header.subarray(8, 13).equals(Buffer.from([8, 6, 0, 0, 0]))) throw new Error("Only 8-bit RGBA is supported")
  const raw = inflateSync(Buffer.concat(chunks.get("IDAT") ?? []))
  const stride = width * 4
  if (raw.length !== (stride + 1) * height) throw new Error("Bad image data length")
  const rgba = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error("Only filter 0 is supported")
    rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride)
  }
  return { width, height, rgba }
}

/** A 64-bit average hash as 16 lowercase hex digits: 8x8 luminance samples, each bit set when above their mean. */
export function averageHash(image: Image) {
  const samples = Array.from({ length: 64 }, (_, index) => {
    const x = Math.min(image.width - 1, Math.floor((((index % 8) + 0.5) * image.width) / 8))
    const y = Math.min(image.height - 1, Math.floor(((Math.floor(index / 8) + 0.5) * image.height) / 8))
    const offset = (y * image.width + x) * 4
    return 0.299 * image.rgba[offset]! + 0.587 * image.rgba[offset + 1]! + 0.114 * image.rgba[offset + 2]!
  })
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  return Array.from({ length: 16 }, (_, nibble) =>
    samples
      .slice(nibble * 4, nibble * 4 + 4)
      .reduce((value, sample) => (value << 1) | (sample > mean ? 1 : 0), 0)
      .toString(16),
  ).join("")
}

/**
 * The largest size within the budget that keeps the aspect ratio and never upscales: each side at least 1, and
 * `width * height` at most `maxPixels` after rounding down. `scale` is the one factor both sides were cut with, and
 * it is the capture's image scale: each side rounds down from `side * scale`, so every pixel's centre lies inside
 * the target. The ratio of the smaller side instead would push the other side's last pixel past the target's edge.
 */
export function fit(width: number, height: number, budget: Budget) {
  const scale = Math.min(
    1,
    budget.maxWidth / width,
    budget.maxHeight / height,
    Math.sqrt(budget.maxPixels / (width * height)),
  )
  // Raising a side that rounded to 0 up to 1 can break the pixel cap on a very long, thin target, so the other side
  // is capped again. Only there (a side under one pixel at `scale`) can a pixel's centre fall outside the target.
  const rows = Math.max(1, Math.floor(height * scale))
  const columns = Math.max(1, Math.min(Math.floor(width * scale), Math.floor(budget.maxPixels / rows)))
  return { width: columns, height: Math.max(1, Math.min(rows, Math.floor(budget.maxPixels / columns))), scale }
}
