import { decodeModules, QrError } from "./decode"

// Finds a QR code in a camera frame and reads it (WP A42): the phone app's scanner uses this where the browser has no
// BarcodeDetector (Safari on iPhone). The frame is binarized with a local threshold, the three finder patterns are
// found from their 1:1:3:1:1 runs, the bottom-right alignment pattern is looked for near where they put it, and a
// perspective transform from those four points samples the modules for decode.ts.

export type Pixels = { width: number; height: number; data: ArrayLike<number> }
type Point = { x: number; y: number }
type Finder = Point & { module: number; count: number }

/** The text of the first QR code found in an RGBA image, or undefined. */
export function scanImage(image: Pixels): string | undefined {
  if (image.width < 21 || image.height < 21 || image.data.length < image.width * image.height * 4) return undefined
  const dark = binarize(image)
  const finders = findFinders(dark, image.width, image.height)
  for (const trio of trios(finders)) {
    const text = readTrio(dark, image.width, image.height, trio)
    if (text !== undefined) return text
  }
  return undefined
}

// ── Binarizing ────────────────────────────────────────────────────────────────────────────────────────────────────

const BLOCK = 8
const MIN_RANGE = 24

/** One byte per pixel, 1 for dark: each 8×8 block is compared with the mean of the 5×5 blocks around it. */
export function binarize(image: Pixels) {
  const { width, height, data } = image
  const luminance = new Uint8Array(width * height)
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4
    luminance[index] = (data[offset]! * 299 + data[offset + 1]! * 587 + data[offset + 2]! * 114) / 1000
  }
  const columns = Math.ceil(width / BLOCK)
  const rows = Math.ceil(height / BLOCK)
  const points = new Float64Array(columns * rows)
  for (let by = 0; by < rows; by++)
    for (let bx = 0; bx < columns; bx++) {
      let sum = 0
      let count = 0
      let min = 255
      let max = 0
      for (let y = by * BLOCK; y < Math.min(height, (by + 1) * BLOCK); y++)
        for (let x = bx * BLOCK; x < Math.min(width, (bx + 1) * BLOCK); x++) {
          const value = luminance[y * width + x]!
          sum += value
          count += 1
          if (value < min) min = value
          if (value > max) max = value
        }
      let average = sum / count
      if (max - min <= MIN_RANGE) {
        // A flat block is taken as light, unless its neighbours say the area is dark.
        average = min / 2
        if (by > 0 && bx > 0) {
          const neighbours =
            (points[(by - 1) * columns + bx]! + 2 * points[by * columns + bx - 1]! + points[(by - 1) * columns + bx - 1]!) /
            4
          if (min < neighbours) average = neighbours
        }
      }
      points[by * columns + bx] = average
    }
  const dark = new Uint8Array(width * height)
  for (let by = 0; by < rows; by++)
    for (let bx = 0; bx < columns; bx++) {
      const left = Math.min(Math.max(bx, 2), Math.max(2, columns - 3))
      const top = Math.min(Math.max(by, 2), Math.max(2, rows - 3))
      let sum = 0
      let count = 0
      for (let y = top - 2; y <= top + 2; y++)
        for (let x = left - 2; x <= left + 2; x++)
          if (x >= 0 && y >= 0 && x < columns && y < rows) {
            sum += points[y * columns + x]!
            count += 1
          }
      const threshold = sum / count
      for (let y = by * BLOCK; y < Math.min(height, (by + 1) * BLOCK); y++)
        for (let x = bx * BLOCK; x < Math.min(width, (bx + 1) * BLOCK); x++)
          dark[y * width + x] = luminance[y * width + x]! <= threshold ? 1 : 0
    }
  return dark
}

// ── Finder patterns ───────────────────────────────────────────────────────────────────────────────────────────────

function ratioMatches(runs: readonly number[]) {
  const total = runs.reduce((sum, run) => sum + run, 0)
  if (total < 7 || runs.some((run) => run === 0)) return false
  const module = total / 7
  const tolerance = module / 1.6
  return (
    Math.abs(runs[0]! - module) < tolerance &&
    Math.abs(runs[1]! - module) < tolerance &&
    Math.abs(runs[2]! - 3 * module) < 3 * tolerance &&
    Math.abs(runs[3]! - module) < tolerance &&
    Math.abs(runs[4]! - module) < tolerance
  )
}

/**
 * Runs of dark, light, dark, light, dark through (x, y) along (dx, dy), the middle run containing the point, or
 * undefined when the point is not dark or a run reaches the image's edge.
 */
function crossRuns(dark: Uint8Array, width: number, height: number, x: number, y: number, dx: number, dy: number) {
  const at = (step: number) => {
    const px = Math.round(x + dx * step)
    const py = Math.round(y + dy * step)
    if (px < 0 || py < 0 || px >= width || py >= height) return -1
    return dark[py * width + px]!
  }
  if (at(0) !== 1) return undefined
  const runs = [0, 0, 0, 0, 0]
  let step = 0
  // Backwards: the rest of the middle run, then light, then dark.
  while (at(step) === 1) {
    runs[2]! += 1
    step -= 1
  }
  while (at(step) === 0) {
    runs[1]! += 1
    step -= 1
  }
  while (at(step) === 1) {
    runs[0]! += 1
    step -= 1
  }
  if (at(step) === -1) return undefined
  const back = step
  step = 1
  while (at(step) === 1) {
    runs[2]! += 1
    step += 1
  }
  while (at(step) === 0) {
    runs[3]! += 1
    step += 1
  }
  while (at(step) === 1) {
    runs[4]! += 1
    step += 1
  }
  if (at(step) === -1) return undefined
  // The middle run's centre, as a step from the point.
  const middleStart = back + 1 + runs[0]! + runs[1]!
  return { runs, centre: middleStart + runs[2]! / 2 - 0.5 }
}

export function findFinders(dark: Uint8Array, width: number, height: number): Finder[] {
  const found: Finder[] = []
  const skip = Math.max(1, Math.floor(height / 200))
  for (let y = 0; y < height; y += skip) {
    const runs: { dark: boolean; start: number; length: number }[] = []
    for (let x = 0; x < width; x++) {
      const value = dark[y * width + x] === 1
      const last = runs[runs.length - 1]
      if (last && last.dark === value) last.length += 1
      else runs.push({ dark: value, start: x, length: 1 })
    }
    for (let index = 0; index + 5 <= runs.length; index++) {
      if (!runs[index]!.dark) continue
      const window = runs.slice(index, index + 5)
      if (!ratioMatches(window.map((run) => run.length))) continue
      const middle = window[2]!
      const x = middle.start + middle.length / 2 - 0.5
      const vertical = crossRuns(dark, width, height, x, y, 0, 1)
      if (!vertical || !ratioMatches(vertical.runs)) continue
      const cy = y + vertical.centre
      const horizontal = crossRuns(dark, width, height, x, cy, 1, 0)
      if (!horizontal || !ratioMatches(horizontal.runs)) continue
      const cx = x + horizontal.centre
      const diagonal = crossRuns(dark, width, height, cx, cy, 1, 1)
      if (!diagonal || !ratioMatches(diagonal.runs)) continue
      const module =
        (vertical.runs.reduce((a, b) => a + b, 0) + horizontal.runs.reduce((a, b) => a + b, 0)) / 14
      const near = found.find(
        (item) =>
          Math.abs(item.x - cx) <= module && Math.abs(item.y - cy) <= module && Math.abs(item.module - module) <= module,
      )
      if (near) {
        const weight = near.count
        near.x = (near.x * weight + cx) / (weight + 1)
        near.y = (near.y * weight + cy) / (weight + 1)
        near.module = (near.module * weight + module) / (weight + 1)
        near.count += 1
      } else found.push({ x: cx, y: cy, module, count: 1 })
    }
  }
  return found
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Likely triples of finder patterns, best first, each as [top-left, top-right, bottom-left]. */
function trios(finders: Finder[]): [Finder, Finder, Finder][] {
  const strong = finders.filter((item) => item.count >= 2)
  const pool = (strong.length >= 3 ? strong : finders).sort((a, b) => b.count - a.count).slice(0, 12)
  const result: { score: number; trio: [Finder, Finder, Finder] }[] = []
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      for (let k = j + 1; k < pool.length; k++) {
        const points = [pool[i]!, pool[j]!, pool[k]!]
        const modules = points.map((point) => point.module)
        if (Math.max(...modules) > Math.min(...modules) * 2) continue
        const sides = [
          { a: 1, b: 2, length: distance(points[1]!, points[2]!) },
          { a: 0, b: 2, length: distance(points[0]!, points[2]!) },
          { a: 0, b: 1, length: distance(points[0]!, points[1]!) },
        ]
        // The corner opposite the longest side is the top-left finder.
        const longest = sides.reduce((best, side) => (side.length > best.length ? side : best))
        const corner = [0, 1, 2].find((index) => index !== longest.a && index !== longest.b)!
        let a = points[longest.a]!
        let c = points[longest.b]!
        const b = points[corner]!
        const legs = [distance(a, b), distance(c, b)]
        const module = (modules[0]! + modules[1]! + modules[2]!) / 3
        if (Math.min(...legs) < module * 12) continue
        if (Math.max(...legs) > Math.min(...legs) * 1.8) continue
        const square = legs[0]! ** 2 + legs[1]! ** 2
        const right = Math.abs(longest.length ** 2 - square) / square
        if (right > 0.35) continue
        // In image coordinates (y down) the top-right finder is clockwise from the bottom-left one.
        const cross = (c.x - b.x) * (a.y - b.y) - (c.y - b.y) * (a.x - b.x)
        if (cross < 0) [a, c] = [c, a]
        result.push({ score: right + Math.abs(legs[0]! - legs[1]!) / Math.max(...legs), trio: [b, c, a] })
      }
  return result.sort((x, y) => x.score - y.score).map((item) => item.trio)
}

// ── Sampling ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A perspective transform from four (u, v) → (x, y) pairs. */
export function homography(from: readonly Point[], to: readonly Point[]) {
  const rows: number[][] = []
  for (let index = 0; index < 4; index++) {
    const { x: u, y: v } = from[index]!
    const { x, y } = to[index]!
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x])
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y, y])
  }
  // Gaussian elimination with partial pivoting.
  for (let column = 0; column < 8; column++) {
    let pivot = column
    for (let row = column + 1; row < 8; row++)
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row
    if (Math.abs(rows[pivot]![column]!) < 1e-12) return undefined
    ;[rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!]
    for (let row = 0; row < 8; row++) {
      if (row === column) continue
      const factor = rows[row]![column]! / rows[column]![column]!
      for (let k = column; k < 9; k++) rows[row]![k]! -= factor * rows[column]![k]!
    }
  }
  const h = rows.map((row, index) => row[8]! / row[index]!)
  return (u: number, v: number): Point => {
    const w = h[6]! * u + h[7]! * v + 1
    return { x: (h[0]! * u + h[1]! * v + h[2]!) / w, y: (h[3]! * u + h[4]! * v + h[5]!) / w }
  }
}

/**
 * Alignment patterns near `estimate`, nearest first: a dark module, a light ring and a dark ring, one module each,
 * checked across, down and on both diagonals so a dark data module among light ones does not pass. The search reaches
 * 16 modules out, since perspective moves the pattern away from where the finders alone put it, and larger versions
 * have several patterns there: each is tried in turn, and decoding decides.
 */
export function findAlignments(dark: Uint8Array, width: number, height: number, estimate: Point, module: number) {
  const at = (x: number, y: number) => {
    const px = Math.round(x)
    const py = Math.round(y)
    return px >= 0 && py >= 0 && px < width && py < height ? dark[py * width + px] === 1 : undefined
  }
  const ring = (x: number, y: number, size: number) => {
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
    ] as const) {
      const step = Math.hypot(dx, dy) > 1 ? size : size
      for (const sign of [1, -1]) {
        if (at(x + sign * dx * step, y + sign * dy * step) !== false) return false
        if (at(x + sign * dx * step * 2, y + sign * dy * step * 2) !== true) return false
      }
    }
    return at(x, y) === true
  }
  const fits = (run: number) => Math.abs(run - module) < module * 0.75
  const radius = Math.max(16 * module, 12)
  const found: { point: Point; offset: number }[] = []
  const left = Math.max(0, Math.floor(estimate.x - radius))
  const right = Math.min(width - 1, Math.ceil(estimate.x + radius))
  const top = Math.max(0, Math.floor(estimate.y - radius))
  const bottom = Math.min(height - 1, Math.ceil(estimate.y + radius))
  for (let y = top; y <= bottom; y++) {
    const runs: { dark: boolean; start: number; length: number }[] = []
    for (let x = left; x <= right; x++) {
      const value = dark[y * width + x] === 1
      const last = runs[runs.length - 1]
      if (last && last.dark === value) last.length += 1
      else runs.push({ dark: value, start: x, length: 1 })
    }
    for (let index = 2; index + 2 < runs.length; index++) {
      const middle = runs[index]!
      if (!middle.dark || !fits(middle.length) || !fits(runs[index - 1]!.length) || !fits(runs[index + 1]!.length))
        continue
      const x = middle.start + middle.length / 2 - 0.5
      let up = 0
      while (at(x, y - up - 1) === true) up += 1
      let down = 0
      while (at(x, y + down + 1) === true) down += 1
      const tall = up + down + 1
      if (!fits(tall)) continue
      const point = { x, y: y - up + tall / 2 - 0.5 }
      if (!ring(point.x, point.y, (middle.length + tall) / 2)) continue
      if (found.some((item) => distance(item.point, point) < module)) continue
      found.push({ point, offset: distance(point, estimate) })
    }
  }
  return found
    .sort((a, b) => a.offset - b.offset)
    .slice(0, 6)
    .map((item) => item.point)
}

function readTrio(dark: Uint8Array, width: number, height: number, [b, c, a]: [Finder, Finder, Finder]) {
  const module = (a.module + b.module + c.module) / 3
  // Modules between the finder centres along each side, with the module size measured along that side (a turned
  // code's modules are longer across a row than along the side; a tilted code's grow toward the camera).
  const along = (from: Finder, to: Finder) => {
    const length = distance(from, to)
    const runs = crossRuns(dark, width, height, from.x, from.y, (to.x - from.x) / length, (to.y - from.y) / length)
    return runs && ratioMatches(runs.runs) ? runs.runs.reduce((sum, run) => sum + run, 0) / 7 : from.module
  }
  const across = distance(b, c) / ((along(b, c) + along(c, b)) / 2)
  const down = distance(b, a) / ((along(b, a) + along(a, b)) / 2)
  const estimate = (across + down) / 2 + 7
  // The valid sizes (17 + 4·version) nearest the estimate first.
  const dimensions = Array.from({ length: 25 }, (_, index) => 21 + 4 * index)
    .filter((candidate) => Math.abs(candidate - estimate) <= 9)
    .sort((x, y) => Math.abs(x - estimate) - Math.abs(y - estimate))
  // The alignment search does not depend on the size tried, so its answers are kept per estimate.
  const searched = new Map<string, Point[]>()
  const alignments = (expected: Point) => {
    const key = `${Math.round(expected.x / module)},${Math.round(expected.y / module)}`
    if (!searched.has(key)) searched.set(key, findAlignments(dark, width, height, expected, module))
    return searched.get(key)!
  }
  for (const dimension of dimensions) {
    // Where a fourth finder would be: the parallelogram's corner, moved by how much larger the bottom-left finder's
    // modules are than the top-left's (a code tilted toward the camera at the bottom is wider there).
    const parallel = { x: c.x - b.x + a.x, y: c.y - b.y + a.y }
    const grow = a.module / b.module
    const corner = {
      x: (parallel.x + a.x + (c.x - b.x) * grow) / 2,
      y: (parallel.y + a.y + (c.y - b.y) * grow) / 2,
    }
    const attempts: { grid: Point; image: Point }[] = []
    if (dimension > 21) {
      const correction = 1 - 3 / (dimension - 7)
      const expected = { x: b.x + correction * (corner.x - b.x), y: b.y + correction * (corner.y - b.y) }
      for (const alignment of alignments(expected))
        attempts.push({ grid: { x: dimension - 6.5, y: dimension - 6.5 }, image: alignment })
    }
    attempts.push({ grid: { x: dimension - 3.5, y: dimension - 3.5 }, image: corner })
    attempts.push({ grid: { x: dimension - 3.5, y: dimension - 3.5 }, image: parallel })
    for (const fourth of attempts) {
      const transform = homography(
        [{ x: 3.5, y: 3.5 }, { x: dimension - 3.5, y: 3.5 }, { x: 3.5, y: dimension - 3.5 }, fourth.grid],
        [b, c, a, fourth.image],
      )
      if (!transform) continue
      const modules: boolean[][] = []
      let outside = false
      for (let y = 0; y < dimension && !outside; y++) {
        const row: boolean[] = []
        for (let x = 0; x < dimension; x++) {
          const point = transform(x + 0.5, y + 0.5)
          const px = Math.round(point.x)
          const py = Math.round(point.y)
          if (px < 0 || py < 0 || px >= width || py >= height) {
            outside = true
            break
          }
          row.push(dark[py * width + px] === 1)
        }
        modules.push(row)
      }
      if (outside) continue
      try {
        return decodeModules(modules)
      } catch (error) {
        if (!(error instanceof QrError)) throw error
      }
    }
  }
  return undefined
}
