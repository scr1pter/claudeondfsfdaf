import {
  bit,
  blocks,
  correctBlock,
  countBits,
  dataOrder,
  formatBits,
  formatPlaces,
  functionPatterns,
  masked,
  MAX_VERSION,
  MIN_VERSION,
  size,
  totalCodewords,
  versionBits,
  versionPlaces,
  type Level,
} from "./tables"

// Reads a QR code's modules back to its text (WP A42): the phone app's scanner samples the camera image into modules
// (image.ts) and this decodes them, correcting errors with each block's Reed-Solomon codewords. Byte, numeric and
// alphanumeric segments are read; anything else ends the text. Throws QrError when the modules do not decode.

export class QrError extends Error {}

const LEVELS: Level[] = ["L", "M", "Q", "H"]
const FORMATS = LEVELS.flatMap((level) =>
  [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => ({ level, mask, bits: formatBits(level, mask) })),
)

function distance(a: number, b: number) {
  let value = a ^ b
  let count = 0
  while (value) {
    count += value & 1
    value >>>= 1
  }
  return count
}

function readBits(modules: readonly (readonly boolean[])[], places: [number, number][]) {
  return places.reduce((value, [x, y], index) => (modules[y]![x] ? value | (1 << index) : value), 0)
}

/** The level and mask from either copy of the format bits, allowing up to three wrong bits. */
export function readFormat(modules: readonly (readonly boolean[])[], version: number) {
  const places = formatPlaces(version)
  const copies = [readBits(modules, places.first), readBits(modules, places.second)]
  let best: { level: Level; mask: number; errors: number } | undefined
  for (const copy of copies)
    for (const format of FORMATS) {
      const errors = distance(copy, format.bits)
      if (!best || errors < best.errors) best = { level: format.level, mask: format.mask, errors }
    }
  if (!best || best.errors > 3) throw new QrError("The format information does not read.")
  return best
}

/** The version from the size, checked against the version bits for versions 7 and up. */
export function readVersion(modules: readonly (readonly boolean[])[]) {
  const n = modules.length
  const fromSize = (n - 17) / 4
  if (!Number.isInteger(fromSize) || fromSize < MIN_VERSION) throw new QrError("That is not a QR code's size.")
  if (fromSize < 7) return fromSize
  const places = versionPlaces(fromSize)
  const copies = [readBits(modules, places.first), readBits(modules, places.second)]
  let best: { version: number; errors: number } | undefined
  for (const copy of copies)
    for (let version = 7; version <= 40; version++) {
      const errors = distance(copy, versionBits(version))
      if (!best || errors < best.errors) best = { version, errors }
    }
  if (!best || best.errors > 3 || best.version !== fromSize) throw new QrError("The version information does not read.")
  return best.version
}

/** The text a square of modules (true for dark) holds. */
export function decodeModules(modules: readonly (readonly boolean[])[]): string {
  const version = readVersion(modules)
  if (version > MAX_VERSION) throw new QrError("That QR code is larger than Vector makes.")
  const n = size(version)
  if (modules.length !== n || modules.some((row) => row.length !== n)) throw new QrError("The modules are not square.")
  const { level, mask } = readFormat(modules, version)
  const { fixed } = functionPatterns(version)
  const order = dataOrder(version, fixed)
  const total = totalCodewords(version)
  const codewords = new Array<number>(total).fill(0)
  for (let index = 0; index < total * 8; index++) {
    const [x, y] = order[index]!
    const value = modules[y]![x]! !== masked(mask, x, y)
    if (value) codewords[index >>> 3] |= 1 << (7 - (index & 7))
  }
  const structure = blocks(version, level)
  const lengths = structure.data
  const split = lengths.map((length) => ({ data: new Array<number>(length), ec: new Array<number>(structure.ec) }))
  let offset = 0
  const longest = Math.max(...lengths)
  for (let index = 0; index < longest; index++)
    for (const block of split) if (index < block.data.length) block.data[index] = codewords[offset++]!
  for (let index = 0; index < structure.ec; index++) for (const block of split) block.ec[index] = codewords[offset++]!
  const data: number[] = []
  for (const block of split) {
    const whole = [...block.data, ...block.ec]
    try {
      correctBlock(whole, structure.ec)
    } catch {
      throw new QrError("The QR code has too many errors to read.")
    }
    data.push(...whole.slice(0, block.data.length))
  }
  return segments(data, version)
}

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"

function segments(data: readonly number[], version: number) {
  let position = 0
  const length = data.length * 8
  const read = (count: number) => {
    if (position + count > length) throw new QrError("The QR code's data ends early.")
    let value = 0
    for (let index = 0; index < count; index++) {
      value = (value << 1) | (bit(data[(position + index) >>> 3]!, 7 - ((position + index) & 7)) ? 1 : 0)
    }
    position += count
    return value
  }
  const bytes: number[] = []
  let text = ""
  const flush = () => {
    if (!bytes.length) return
    text += new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes))
    bytes.length = 0
  }
  while (position + 4 <= length) {
    const mode = read(4)
    if (mode === 0) break
    if (mode === 0b0100) {
      const count = read(countBits(version))
      for (let index = 0; index < count; index++) bytes.push(read(8))
      continue
    }
    flush()
    if (mode === 0b0001) {
      let count = read(version <= 9 ? 10 : version <= 26 ? 12 : 14)
      while (count >= 3) {
        text += String(read(10)).padStart(3, "0")
        count -= 3
      }
      if (count === 2) text += String(read(7)).padStart(2, "0")
      if (count === 1) text += String(read(4))
      continue
    }
    if (mode === 0b0010) {
      let count = read(version <= 9 ? 9 : version <= 26 ? 11 : 13)
      while (count >= 2) {
        const value = read(11)
        text += ALPHANUMERIC[Math.floor(value / 45)]! + ALPHANUMERIC[value % 45]!
        count -= 2
      }
      if (count === 1) text += ALPHANUMERIC[read(6)]!
      continue
    }
    if (mode === 0b0111) {
      // An ECI designator: Vector's codes never carry one; its value is read past.
      const first = read(8)
      if ((first & 0x80) !== 0) read((first & 0x40) === 0 ? 8 : 16)
      continue
    }
    break
  }
  flush()
  return text
}
