import {
  bit,
  blocks,
  countBits,
  dataCodewords,
  dataOrder,
  formatBits,
  formatPlaces,
  functionPatterns,
  masked,
  MAX_VERSION,
  MIN_VERSION,
  reedSolomon,
  size,
  versionBits,
  versionPlaces,
  type Level,
} from "./tables"

// A QR code encoder for Vector Remote's pairing link (WP A42): Settings → Remote shows the link as a QR code for the
// phone app to scan. Byte mode, the smallest version from 1 to 25 that holds the text at level M (or L when M cannot),
// and the mask with the lowest penalty, as ISO/IEC 18004 describes. The result is a square of modules, true for dark.

export type QrCode = { version: number; level: Level; mask: number; size: number; modules: boolean[][] }

export function encodeQr(text: string, options: { level?: Level; mask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text)
  const levels: Level[] = options.level ? [options.level] : ["M", "L"]
  for (const level of levels)
    for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
      const capacity = dataCodewords(version, level) * 8
      const needed = 4 + countBits(version) + bytes.length * 8
      if (needed <= capacity) return build(bytes, version, level, options.mask)
    }
  throw new Error("That text is too long for a QR code here.")
}

function build(bytes: Uint8Array, version: number, level: Level, fixedMask?: number): QrCode {
  const codewords = interleave(dataBits(bytes, version, level), version, level)
  const n = size(version)
  const patterns = functionPatterns(version)
  const order = dataOrder(version, patterns.fixed)
  const base = patterns.dark.map((row) => row.slice())
  order.forEach(([x, y], index) => {
    const value = index < codewords.length * 8 ? bit(codewords[index >>> 3]!, 7 - (index & 7)) : false
    base[y]![x] = value
  })
  const candidates = fixedMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [fixedMask]
  let best: { mask: number; modules: boolean[][]; penalty: number } | undefined
  for (const mask of candidates) {
    const modules = base.map((row) => row.slice())
    for (const [x, y] of order) if (masked(mask, x, y)) modules[y]![x] = !modules[y]![x]
    writeFormat(modules, version, level, mask)
    const score = penalty(modules)
    if (!best || score < best.penalty) best = { mask, modules, penalty: score }
  }
  return { version, level, mask: best!.mask, size: n, modules: best!.modules }
}

/** The data codewords: mode, count, the bytes, terminator and padding. */
export function dataBits(bytes: Uint8Array, version: number, level: Level) {
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let index = length - 1; index >= 0; index--) bits.push((value >>> index) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, countBits(version))
  for (const byte of bytes) push(byte, 8)
  const capacity = dataCodewords(version, level) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const result: number[] = []
  for (let index = 0; index < bits.length; index += 8)
    result.push(bits.slice(index, index + 8).reduce((byte, value) => (byte << 1) | value, 0))
  return result
}

/** Splits the data into blocks, adds each block's error correction and interleaves them. */
export function interleave(data: readonly number[], version: number, level: Level) {
  const structure = blocks(version, level)
  const split: { data: number[]; ec: number[] }[] = []
  let offset = 0
  for (const length of structure.data) {
    const part = data.slice(offset, offset + length)
    offset += length
    split.push({ data: part, ec: reedSolomon(part, structure.ec) })
  }
  const result: number[] = []
  const longest = Math.max(...structure.data)
  for (let index = 0; index < longest; index++)
    for (const block of split) if (index < block.data.length) result.push(block.data[index]!)
  for (let index = 0; index < structure.ec; index++) for (const block of split) result.push(block.ec[index]!)
  return result
}

function writeFormat(modules: boolean[][], version: number, level: Level, mask: number) {
  const bits = formatBits(level, mask)
  const places = formatPlaces(version)
  places.first.forEach(([x, y], index) => (modules[y]![x] = bit(bits, index)))
  places.second.forEach(([x, y], index) => (modules[y]![x] = bit(bits, index)))
  if (version >= 7) {
    const value = versionBits(version)
    const versions = versionPlaces(version)
    versions.first.forEach(([x, y], index) => (modules[y]![x] = bit(value, index)))
    versions.second.forEach(([x, y], index) => (modules[y]![x] = bit(value, index)))
  }
}

/** ISO/IEC 18004 §7.8.3's mask penalty: runs, 2×2 blocks, finder-like patterns and the dark share. */
export function penalty(modules: readonly (readonly boolean[])[]) {
  const n = modules.length
  let score = 0
  const lines = (read: (a: number, b: number) => boolean) => {
    for (let a = 0; a < n; a++) {
      let run = 1
      for (let b = 1; b <= n; b++) {
        if (b < n && read(a, b) === read(a, b - 1)) run += 1
        else {
          if (run >= 5) score += run - 2
          run = 1
        }
      }
      for (let b = 0; b + 11 <= n; b++) {
        const window = Array.from({ length: 11 }, (_, index) => read(a, b + index))
        const pattern = [true, false, true, true, true, false, true]
        const core = pattern.every((value, index) => window[index + 4] === value)
        const light = (from: number) => window.slice(from, from + 4).every((value) => !value)
        if (core && light(0)) score += 40
        const coreFirst = pattern.every((value, index) => window[index] === value)
        if (coreFirst && light(7)) score += 40
      }
    }
  }
  lines((row, column) => modules[row]![column]!)
  lines((column, row) => modules[row]![column]!)
  for (let y = 0; y + 1 < n; y++)
    for (let x = 0; x + 1 < n; x++) {
      const value = modules[y]![x]
      if (modules[y]![x + 1] === value && modules[y + 1]![x] === value && modules[y + 1]![x + 1] === value) score += 3
    }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10
  return score
}

/** The code as one SVG path (`d`), one unit per module, offset by the quiet zone. */
export function qrPath(code: QrCode, quiet = 4) {
  const parts: string[] = []
  code.modules.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (!row[x]) {
        x += 1
        continue
      }
      const start = x
      while (x < row.length && row[x]) x += 1
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`)
    }
  })
  return { d: parts.join(""), size: code.size + quiet * 2 }
}
