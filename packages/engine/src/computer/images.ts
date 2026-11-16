const PNG = "data:image/png;base64,"
const JPEG = "data:image/jpeg;base64,"
// Whole base64 quartets decode to at most 65,535 bytes, below the 64 KiB header budget.
const HEADER_CHARS = 87_380
const MAX_DIMENSION = 16_384
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** Read frame geometry before decoding pixels. Image.normalize separately validates the complete encoded image. */
export function dimensions(url: string): { w: number; h: number } | undefined {
  const start = url.startsWith(PNG) ? PNG.length : url.startsWith(JPEG) ? JPEG.length : 0
  if (!start) return
  const encoded = url.slice(start, start + HEADER_CHARS)
  if (!encoded || encoded.length % 4 === 1 || /[\r\n]/.test(encoded) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return
  if (url.length > start + HEADER_CHARS && encoded.includes("=")) return
  const header = Buffer.from(encoded, "base64")

  if (start === PNG.length) {
    if (header.length < 33 || !header.subarray(0, 8).equals(PNG_SIGNATURE)) return
    if (header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR") return
    const depth = header[24]
    const color = header[25]
    if (
      !(
        (color === 0 && [1, 2, 4, 8, 16].includes(depth)) ||
        (color === 3 && [1, 2, 4, 8].includes(depth)) ||
        ([2, 4, 6].includes(color) && [8, 16].includes(depth))
      ) ||
      header[26] !== 0 ||
      header[27] !== 0 ||
      header[28] > 1
    )
      return
    return size(header.readUInt32BE(16), header.readUInt32BE(20))
  }

  if (header.length < 4 || header[0] !== 0xff || header[1] !== 0xd8) return
  for (let at = 2; at < header.length; ) {
    if (header[at++] !== 0xff) return
    while (at < header.length && header[at] === 0xff) at++
    if (at >= header.length) return
    const marker = header[at++]
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda || (marker >= 0xd0 && marker <= 0xd7))
      return
    if (marker === 0x01) continue
    if (at + 2 > header.length) return
    const length = header.readUInt16BE(at)
    if (length < 2 || at + length > header.length) return
    if (SOF.has(marker)) {
      if (length < 11 || header[at + 2] < 2 || header[at + 2] > 16) return
      const components = header[at + 7]
      if (components < 1 || components > 4 || length !== 8 + components * 3) return
      const ids = new Set<number>()
      for (let component = 0; component < components; component++) {
        const offset = at + 8 + component * 3
        const sampling = header[offset + 1]
        if (
          ids.has(header[offset]) ||
          sampling >> 4 < 1 ||
          sampling >> 4 > 4 ||
          (sampling & 15) < 1 ||
          (sampling & 15) > 4 ||
          header[offset + 2] > 3
        )
          return
        ids.add(header[offset])
      }
      return size(header.readUInt16BE(at + 5), header.readUInt16BE(at + 3))
    }
    at += length
  }
}

function size(w: number, h: number) {
  return w > 0 && h > 0 && w <= MAX_DIMENSION && h <= MAX_DIMENSION ? { w, h } : undefined
}

export * as ComputerImages from "./images"
