// QR code model 2 (ISO/IEC 18004) as Vector Remote's pairing needs it (WP A42): what the encoder and the decoder share.
// Byte mode only; versions 1 to 25, which hold far more than a pairing link. No dependency, no Node or browser API.

export type Level = "L" | "M" | "Q" | "H"
export const MIN_VERSION = 1
export const MAX_VERSION = 25

/** The two format bits each error correction level is written as. */
export const LEVEL_BITS: Readonly<Record<Level, number>> = { L: 1, M: 0, Q: 3, H: 2 }

// Error correction codewords per block and number of blocks, by level, for versions 1..25 (index 0 unused).
// The data codewords per block follow from the symbol's size (`blocks`).
const EC_PER_BLOCK: Readonly<Record<Level, readonly number[]>> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30],
}
const BLOCKS: Readonly<Record<Level, readonly number[]>> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35],
}

export function size(version: number) {
  return 17 + 4 * version
}

/** Modules that carry data or error correction (all but the function patterns and format and version bits). */
export function rawDataModules(version: number) {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2
    result -= (25 * count - 10) * count - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** Every codeword the symbol holds, data and error correction together. */
export function totalCodewords(version: number) {
  return Math.floor(rawDataModules(version) / 8)
}

/** The block structure: data codewords per block (short blocks first, then long ones one longer) and EC per block. */
export function blocks(version: number, level: Level) {
  const count = BLOCKS[level][version]!
  const ec = EC_PER_BLOCK[level][version]!
  const total = totalCodewords(version)
  const short = Math.floor(total / count) - ec
  const long = total % count
  return {
    ec,
    data: Array.from({ length: count }, (_, index) => (index < count - long ? short : short + 1)),
  }
}

export function dataCodewords(version: number, level: Level) {
  return blocks(version, level).data.reduce((sum, length) => sum + length, 0)
}

/** Bits of the character count in byte mode. */
export function countBits(version: number) {
  return version <= 9 ? 8 : 16
}

/** The centres of the alignment patterns along each axis. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let position = size(version) - 7; result.length < count; position -= step) result.splice(1, 0, position)
  return result
}

/** The 15 format bits for a level and mask: BCH(15,5) with the fixed XOR mask. */
export function formatBits(level: Level, mask: number) {
  const data = (LEVEL_BITS[level] << 3) | mask
  let remainder = data
  for (let index = 0; index < 10; index++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  return ((data << 10) | remainder) ^ 0x5412
}

/** The 18 version bits for versions 7 and up: BCH(18,6). */
export function versionBits(version: number) {
  let remainder = version
  for (let index = 0; index < 12; index++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  return (version << 12) | remainder
}

export function bit(value: number, index: number) {
  return ((value >>> index) & 1) !== 0
}

/** Whether mask `mask` flips the module at column `x`, row `y`. */
export function masked(mask: number, x: number, y: number) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

/**
 * The symbol's function patterns (finders, separators, timing, alignment, the dark module, format and version areas)
 * with their colours. `function_[y][x]` says the module is not data; `dark[y][x]` is its colour where it is.
 */
export function functionPatterns(version: number) {
  const n = size(version)
  const dark = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const fixed = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const set = (x: number, y: number, value: boolean) => {
    dark[y]![x] = value
    fixed[y]![x] = true
  }
  for (let index = 0; index < n; index++) {
    set(6, index, index % 2 === 0)
    set(index, 6, index % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= n || y >= n) continue
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        set(x, y, distance !== 2 && distance !== 4)
      }
  const positions = alignmentPositions(version)
  const last = positions.length - 1
  for (let i = 0; i <= last; i++)
    for (let j = 0; j <= last; j++) {
      // The three corners with a finder pattern have no alignment pattern.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(positions[i]! + dx, positions[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  // Format areas (their bits are written by the encoder) and the dark module.
  for (let index = 0; index < 9; index++) {
    if (index !== 6) {
      fixed[8]![index] = true
      fixed[index]![8] = true
    }
  }
  for (let index = 0; index < 8; index++) {
    fixed[8]![n - 1 - index] = true
    fixed[n - 1 - index]![8] = true
  }
  set(8, n - 8, true)
  if (version >= 7)
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 3; j++) {
        fixed[i]![n - 11 + j] = true
        fixed[n - 11 + j]![i] = true
      }
  return { dark, fixed }
}

/** The format bits' two places: [x, y] for bit 0 to 14, first copy then second. */
export function formatPlaces(version: number): { first: [number, number][]; second: [number, number][] } {
  const n = size(version)
  const first: [number, number][] = []
  for (let index = 0; index <= 5; index++) first.push([8, index])
  first.push([8, 7], [8, 8], [7, 8])
  for (let index = 9; index < 15; index++) first.push([14 - index, 8])
  const second: [number, number][] = []
  for (let index = 0; index < 8; index++) second.push([n - 1 - index, 8])
  for (let index = 8; index < 15; index++) second.push([8, n - 15 + index])
  return { first, second }
}

/** The version bits' two places: [x, y] for bit 0 to 17, first copy (top right) then second (bottom left). */
export function versionPlaces(version: number): { first: [number, number][]; second: [number, number][] } {
  const n = size(version)
  const first: [number, number][] = []
  const second: [number, number][] = []
  for (let index = 0; index < 18; index++) {
    const a = n - 11 + (index % 3)
    const b = Math.floor(index / 3)
    first.push([a, b])
    second.push([b, a])
  }
  return { first, second }
}

/** The data modules in reading order: [x, y], right to left in two-column strips, zigzagging up and down. */
export function dataOrder(version: number, fixed: readonly (readonly boolean[])[]): [number, number][] {
  const n = size(version)
  const order: [number, number][] = []
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < n; vertical++)
      for (let column = 0; column < 2; column++) {
        const x = right - column
        const upward = ((right + 1) & 2) === 0
        const y = upward ? n - 1 - vertical : vertical
        if (!fixed[y]![x]) order.push([x, y])
      }
  }
  return order
}

// ── GF(256) and Reed-Solomon ──────────────────────────────────────────────────────────────────────────────────────

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let value = 1
  for (let index = 0; index < 255; index++) {
    EXP[index] = value
    LOG[value] = index
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let index = 255; index < 512; index++) EXP[index] = EXP[index - 255]!
}

export function gfMultiply(a: number, b: number) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!
}

export function gfDivide(a: number, b: number) {
  if (b === 0) throw new Error("division by zero in GF(256)")
  return a === 0 ? 0 : EXP[(LOG[a]! + 255 - LOG[b]!) % 255]!
}

export function gfPower(exponent: number) {
  return EXP[((exponent % 255) + 255) % 255]!
}

export function gfInverse(a: number) {
  return gfDivide(1, a)
}

/** The generator polynomial of degree `degree`, highest coefficient first, without its leading 1. */
function generator(degree: number) {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let index = 0; index < degree; index++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root)
      if (j + 1 < degree) result[j] ^= result[j + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

/** The error correction codewords for `data`: the remainder of data·x^degree divided by the generator. */
export function reedSolomon(data: readonly number[], degree: number) {
  const divisor = generator(degree)
  const result = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    for (let index = 0; index < degree; index++) result[index] ^= gfMultiply(divisor[index]!, factor)
  }
  return result
}

/**
 * Corrects a received block (data then error correction, highest power first) in place, or throws when it holds more
 * errors than its `degree` error correction codewords can fix. Roots of the generator are α^0..α^(degree-1).
 */
export function correctBlock(block: number[], degree: number) {
  const length = block.length
  // Syndromes S_j = r(α^j).
  const syndromes = new Array<number>(degree).fill(0)
  let clean = true
  for (let j = 0; j < degree; j++) {
    let value = 0
    for (const byte of block) value = gfMultiply(value, gfPower(j)) ^ byte
    syndromes[j] = value
    if (value !== 0) clean = false
  }
  if (clean) return 0
  // Berlekamp-Massey: the error locator Λ(x), lowest power first.
  let locator = [1]
  let previous = [1]
  let errors = 0
  let shift = 1
  let last = 1
  for (let n = 0; n < degree; n++) {
    let discrepancy = syndromes[n]!
    for (let index = 1; index <= errors; index++) discrepancy ^= gfMultiply(locator[index] ?? 0, syndromes[n - index]!)
    if (discrepancy === 0) {
      shift += 1
      continue
    }
    const scale = gfDivide(discrepancy, last)
    const next = locator.slice()
    for (let index = 0; index < previous.length; index++) {
      const at = index + shift
      next[at] = (next[at] ?? 0) ^ gfMultiply(scale, previous[index]!)
    }
    if (2 * errors <= n) {
      previous = locator
      errors = n + 1 - errors
      last = discrepancy
      shift = 1
    } else shift += 1
    locator = next
  }
  while (locator.length > 1 && locator[locator.length - 1] === 0) locator.pop()
  if (locator.length - 1 !== errors || 2 * errors > degree) throw new Error("too many errors")
  // Chien search: position p (0 = last codeword) is in error when Λ(α^-p) = 0.
  const positions: number[] = []
  for (let p = 0; p < length; p++) {
    const x = gfPower(-p)
    let value = 0
    for (let index = locator.length - 1; index >= 0; index--) value = gfMultiply(value, x) ^ locator[index]!
    if (value === 0) positions.push(p)
  }
  if (positions.length !== errors) throw new Error("too many errors")
  // Forney: Ω(x) = S(x)Λ(x) mod x^degree; e_p = X·Ω(X^-1)/Λ'(X^-1) with X = α^p (the generator's first root is α^0).
  const omega = new Array<number>(degree).fill(0)
  for (let i = 0; i < degree; i++)
    for (let j = 0; j < locator.length && i + j < degree; j++) omega[i + j] ^= gfMultiply(syndromes[i]!, locator[j]!)
  for (const p of positions) {
    const inverse = gfPower(-p)
    let numerator = 0
    for (let index = omega.length - 1; index >= 0; index--) numerator = gfMultiply(numerator, inverse) ^ omega[index]!
    let denominator = 0
    for (let index = 1; index < locator.length; index += 2)
      denominator ^= gfMultiply(locator[index]!, gfPower(-p * (index - 1)))
    if (denominator === 0) throw new Error("too many errors")
    const magnitude = gfMultiply(gfPower(p), gfDivide(numerator, denominator))
    block[length - 1 - p] ^= magnitude
  }
  return errors
}
