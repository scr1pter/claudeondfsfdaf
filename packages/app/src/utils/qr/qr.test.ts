import { describe, expect, test } from "bun:test"
import { decodeModules, QrError } from "./decode"
import { encodeQr, qrPath } from "./encode"
import { scanImage, type Pixels } from "./image"
import {
  alignmentPositions,
  blocks,
  correctBlock,
  formatBits,
  MAX_VERSION,
  reedSolomon,
  totalCodewords,
  versionBits,
  type Level,
} from "./tables"

// WP A42: the QR code Settings → Remote shows for pairing, and the phone app's scanner that reads it back. The
// encoder's parts are checked against ISO/IEC 18004's published values; whole symbols round-trip through the decoder,
// with errors corrected and from synthetic camera images.

// ISO/IEC 18004 Table 9, versions 1–25: [blocks in group 1, data codewords each, blocks in group 2, data each].
const TABLE: Record<Level, [number, number, number?, number?][]> = {
  L: [
    [1, 19], [1, 34], [1, 55], [1, 80], [1, 108], [2, 68], [2, 78], [2, 97], [2, 116], [2, 68, 2, 69],
    [4, 81], [2, 92, 2, 93], [4, 107], [3, 115, 1, 116], [5, 87, 1, 88], [5, 98, 1, 99], [1, 107, 5, 108],
    [5, 120, 1, 121], [3, 113, 4, 114], [3, 107, 5, 108], [4, 116, 4, 117], [2, 111, 7, 112], [4, 121, 5, 122],
    [6, 117, 4, 118], [8, 106, 4, 107],
  ],
  M: [
    [1, 16], [1, 28], [1, 44], [2, 32], [2, 43], [4, 27], [4, 31], [2, 38, 2, 39], [3, 36, 2, 37], [4, 43, 1, 44],
    [1, 50, 4, 51], [6, 36, 2, 37], [8, 37, 1, 38], [4, 40, 5, 41], [5, 41, 5, 42], [7, 45, 3, 46], [10, 46, 1, 47],
    [9, 43, 4, 44], [3, 44, 11, 45], [3, 41, 13, 42], [17, 42], [17, 46], [4, 47, 14, 48], [6, 45, 14, 46],
    [8, 47, 13, 48],
  ],
  Q: [
    [1, 13], [1, 22], [2, 17], [2, 24], [2, 15, 2, 16], [4, 19], [2, 14, 4, 15], [4, 18, 2, 19], [4, 16, 4, 17],
    [6, 19, 2, 20], [4, 22, 4, 23], [4, 20, 6, 21], [8, 20, 4, 21], [11, 16, 5, 17], [5, 24, 7, 25], [15, 19, 2, 20],
    [1, 22, 15, 23], [17, 22, 1, 23], [17, 21, 4, 22], [15, 24, 5, 25], [17, 22, 6, 23], [7, 24, 16, 25],
    [11, 24, 14, 25], [11, 24, 16, 25], [7, 24, 22, 25],
  ],
  H: [
    [1, 9], [1, 16], [2, 13], [4, 9], [2, 11, 2, 12], [4, 15], [4, 13, 1, 14], [4, 14, 2, 15], [4, 12, 4, 13],
    [6, 15, 2, 16], [3, 12, 8, 13], [7, 14, 4, 15], [12, 11, 4, 12], [11, 12, 5, 13], [11, 12, 7, 13], [3, 15, 13, 16],
    [2, 14, 17, 15], [2, 14, 19, 15], [9, 13, 16, 14], [15, 15, 10, 16], [19, 16, 6, 17], [34, 13], [16, 15, 14, 16],
    [30, 16, 2, 17], [22, 15, 13, 16],
  ],
}

describe("the encoder's tables", () => {
  test("every version and level splits into ISO's blocks, filling the symbol exactly", () => {
    for (const level of ["L", "M", "Q", "H"] as const)
      for (let version = 1; version <= MAX_VERSION; version++) {
        const structure = blocks(version, level)
        const [g1, d1, g2 = 0, d2 = 0] = TABLE[level][version - 1]!
        const expected = [...new Array(g1).fill(d1), ...new Array(g2).fill(d2)]
        expect({ version, level, data: structure.data }).toEqual({ version, level, data: expected })
        const used = structure.data.reduce((sum, length) => sum + length + structure.ec, 0)
        expect({ version, level, used }).toEqual({ version, level, used: totalCodewords(version) })
      }
  })

  test("Reed-Solomon matches the standard's 1-M example", () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
    expect(reedSolomon(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55])
  })

  test("format and version bits match the standard's tables", () => {
    const bits = (value: number, length: number) => value.toString(2).padStart(length, "0")
    expect(bits(formatBits("L", 0), 15)).toBe("111011111000100")
    expect(bits(formatBits("L", 4), 15)).toBe("110011000101111")
    expect(bits(formatBits("L", 7), 15)).toBe("110100101110110")
    expect(bits(formatBits("M", 0), 15)).toBe("101010000010010")
    expect(bits(formatBits("M", 5), 15)).toBe("100000011001110")
    expect(bits(formatBits("Q", 0), 15)).toBe("011010101011111")
    expect(bits(formatBits("H", 0), 15)).toBe("001011010001001")
    expect(bits(versionBits(7), 18)).toBe("000111110010010100")
    expect(bits(versionBits(8), 18)).toBe("001000010110111100")
  })

  test("alignment patterns sit where the standard puts them", () => {
    expect(alignmentPositions(1)).toEqual([])
    expect(alignmentPositions(2)).toEqual([6, 18])
    expect(alignmentPositions(7)).toEqual([6, 22, 38])
    expect(alignmentPositions(14)).toEqual([6, 26, 46, 66])
    expect(alignmentPositions(22)).toEqual([6, 26, 50, 74, 98])
    expect(alignmentPositions(25)).toEqual([6, 32, 58, 84, 110])
  })

  test("Reed-Solomon corrects up to half its error correction codewords, and refuses more", () => {
    const data = Array.from({ length: 40 }, (_, index) => (index * 37 + 11) & 0xff)
    const block = [...data, ...reedSolomon(data, 16)]
    const broken = block.slice()
    for (const at of [0, 5, 17, 23, 39, 41, 50, 55]) broken[at] ^= 0x5a
    expect(correctBlock(broken, 16)).toBe(8)
    expect(broken).toEqual(block)
    const ruined = block.slice()
    for (let at = 0; at < 12; at++) ruined[at * 4] ^= 0x33
    let refused = false
    try {
      correctBlock(ruined, 16)
      refused = ruined.slice(0, 40).join() !== data.join()
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
  })
})

const LINK = `https://remote.vectordev.ai/phone/pair#${"A".repeat(300)}`

describe("symbols", () => {
  test("text of every size round-trips through the decoder", () => {
    for (const length of [0, 1, 14, 17, 40, 100, 200, 331, 400, 600, 900]) {
      const text = Array.from({ length }, (_, index) => "abcXYZ019-_#/:é"[index % 15]).join("")
      const code = encodeQr(text)
      expect(code.size).toBe(17 + 4 * code.version)
      expect(decodeModules(code.modules)).toBe(text)
    }
  })

  test("every mask decodes, and the encoder picks one by penalty", () => {
    for (let mask = 0; mask < 8; mask++) {
      const code = encodeQr("vector remote pairing", { mask })
      expect(code.mask).toBe(mask)
      expect(decodeModules(code.modules)).toBe("vector remote pairing")
    }
    const chosen = encodeQr("vector remote pairing")
    expect(chosen.mask).toBeGreaterThanOrEqual(0)
    expect(chosen.level).toBe("M")
  })

  test("a pairing link fits at level M, with room for a long computer name", () => {
    const code = encodeQr(LINK)
    expect(code.level).toBe("M")
    expect(code.version).toBeLessThanOrEqual(15)
    expect(decodeModules(code.modules)).toBe(LINK)
    expect(encodeQr(`${LINK}${"B".repeat(200)}`).version).toBeLessThanOrEqual(MAX_VERSION)
    expect(() => encodeQr("x".repeat(2000))).toThrow()
  })

  test("damaged modules are corrected; a ruined symbol is refused", () => {
    const code = encodeQr(LINK)
    const damaged = code.modules.map((row) => row.slice())
    // A scratch across the middle of the symbol.
    for (let x = 20; x < 30; x++) damaged[Math.floor(code.size / 2)]![x] = !damaged[Math.floor(code.size / 2)]![x]
    expect(decodeModules(damaged)).toBe(LINK)
    const ruined = code.modules.map((row, y) => row.map((value, x) => (x > 12 && y > 12 && (x + y) % 3 === 0 ? !value : value)))
    expect(() => decodeModules(ruined)).toThrow(QrError)
  })

  test("the SVG path draws every dark module and nothing else", () => {
    const code = encodeQr("hi")
    const { d, size } = qrPath(code)
    expect(size).toBe(code.size + 8)
    const drawn = [...d.matchAll(/h(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0)
    expect(drawn).toBe(code.modules.flat().filter(Boolean).length)
    expect(/^[Mhvz0-9 -]+$/.test(d)).toBe(true)
  })
})

/** The code drawn into an RGBA image: `scale` pixels a module, turned, tilted and noisy like a phone camera's frame. */
function photograph(
  modules: boolean[][],
  options: { scale: number; angle?: number; tilt?: number; noise?: number; size?: number; blur?: boolean },
): Pixels {
  const n = modules.length
  const quiet = 4
  const width = options.size ?? Math.ceil((n + quiet * 2) * options.scale * 1.6)
  const height = width
  const data = new Uint8ClampedArray(width * height * 4)
  const angle = ((options.angle ?? 0) * Math.PI) / 180
  const tilt = options.tilt ?? 0
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const centre = width / 2
  const half = ((n + quiet * 2) * options.scale) / 2
  const shade = (px: number, py: number) => {
    // Image point back to the symbol's plane: undo the rotation, then the tilt (a perspective along y).
    const dx = px - centre
    const dy = py - centre
    let u = dx * Math.cos(-angle) - dy * Math.sin(-angle)
    let v = dx * Math.sin(-angle) + dy * Math.cos(-angle)
    const w = 1 + (tilt * v) / half
    u /= w
    v /= w
    const mx = Math.floor((u + half) / options.scale) - quiet
    const my = Math.floor((v + half) / options.scale) - quiet
    const inside = mx >= 0 && my >= 0 && mx < n && my < n
    return inside && modules[my]![mx] ? 30 : 225
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let value = shade(x + 0.5, y + 0.5)
      if (options.blur) value = (value + shade(x + 1.2, y + 0.5) + shade(x + 0.5, y + 1.2) + shade(x - 0.2, y + 0.5)) / 4
      value += ((random() - 0.5) * 2 * (options.noise ?? 0)) | 0
      // An uneven light: brighter to the left.
      value = value * (1 - (0.25 * x) / width)
      const offset = (y * width + x) * 4
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  return { width, height, data }
}

describe("scanning a camera image", () => {
  const code = encodeQr(LINK)

  test("a straight, sharp code reads", () => {
    expect(scanImage(photograph(code.modules, { scale: 4 }))).toBe(LINK)
  })

  test("a turned, tilted, noisy and blurred code reads", () => {
    expect(scanImage(photograph(code.modules, { scale: 5, angle: 17, noise: 30 }))).toBe(LINK)
    expect(scanImage(photograph(code.modules, { scale: 5, angle: -8, tilt: 0.12, noise: 20, blur: true }))).toBe(LINK)
    expect(scanImage(photograph(code.modules, { scale: 5, angle: 180 }))).toBe(LINK)
    expect(scanImage(photograph(code.modules, { scale: 3, angle: 45 }))).toBe(LINK)
    expect(scanImage(photograph(code.modules, { scale: 4, tilt: 0.2 }))).toBe(LINK)
    expect(scanImage(photograph(code.modules, { scale: 6, angle: 100, tilt: -0.15, noise: 15, blur: true }))).toBe(LINK)
  })

  test("a frame the size of a phone camera's reads quickly", () => {
    const frame = photograph(code.modules, { scale: 4, angle: 12, size: 640 })
    const started = performance.now()
    expect(scanImage(frame)).toBe(LINK)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("a small version-1 code reads too", () => {
    const small = encodeQr("pair")
    expect(scanImage(photograph(small.modules, { scale: 6, angle: 30 }))).toBe("pair")
  })

  test("an image with no code reads nothing", () => {
    const blank = { width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(200) }
    expect(scanImage(blank)).toBeUndefined()
    expect(scanImage({ width: 10, height: 10, data: new Uint8ClampedArray(400) })).toBeUndefined()
  })
})
