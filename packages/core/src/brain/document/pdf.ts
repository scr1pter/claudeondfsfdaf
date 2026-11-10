export * as BrainPdf from "./pdf"

import { getDocumentProxy } from "unpdf"
import {
  CMap,
  DecodeStream,
  PartialEvaluator,
  Parser,
  Pattern,
  PDFFunctionFactory,
  StreamsSequenceStream,
} from "unpdf/pdfjs"
import type { BrainSchema } from "../schema"
import { budget, refuse, type BrainLimits } from "./limits"
import type { Draft, Read, ReadRefusal } from "./read"
import { BrainText } from "./text"
import { BrainOcr } from "./ocr"

// PDF text through pdf.js (bundled in unpdf), from bytes only: nothing is rendered, no font is loaded into the system,
// no URL is fetched, and the document's JavaScript and forms never run (pdf.js 6 has no script engine without a
// viewer's sandbox, and no `eval` path at all). Layout is rebuilt from text positions with fixed rules: lines from
// baselines, hyphenated words joined, running headers and footers dropped, two columns read one after the other,
// headings from the outline or from size, weight and numbering, lists from bullets and indents, tables from aligned
// gaps, code from monospace runs. Text too small to read (under 2 pt) or outside the page is dropped and flagged.
// Every coordinate comes from the file, so each is clamped to its page before any size is worked out from it, and a
// page pdf.js cannot read is listed as unread rather than failing the document.

const OPTIONS = {
  disableFontFace: true,
  useSystemFonts: false,
  enableXfa: false,
  stopAtErrors: false,
  verbosity: 0,
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  useWasm: false,
  // Pictures are never read: every one is left out while a page's fonts are resolved, so none is decoded.
  maxImageSize: 0,
}

type Document = Awaited<ReturnType<typeof getDocumentProxy>>

type Item = {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly end: number
  readonly size: number
  readonly bold: boolean
  readonly mono: boolean
}

type Cell = { readonly x: number; readonly end: number; readonly text: string }

type Line = {
  readonly page: number
  readonly y: number
  readonly x: number
  readonly end: number
  readonly size: number
  readonly text: string
  readonly cells: readonly Cell[]
  readonly bold: boolean
  readonly mono: boolean
  readonly code: readonly string[]
  /** Distance from the page's top and bottom edges, for running headers and footers. */
  readonly top: number
  readonly bottom: number
  hidden: boolean
}

type Heading = { readonly title: string; readonly page: number; readonly level: number }

/** Fewer visible characters than this on a page means it has no text layer: a scan. */
const SCANNED = 25

const TOO_LARGE = "This PDF expands to more than Vector reads safely, so it was not read."

/** One PDF at a time, since the decoders count against the read under way (see `decoding`). */
const queue = { tail: Promise.resolve() as Promise<unknown> }

export function read(bytes: Uint8Array, limits: BrainLimits.Limits, signal?: AbortSignal): Promise<Read | ReadRefusal> {
  const turn = queue.tail.then(() => readOne(bytes, limits, signal))
  queue.tail = turn.catch(() => undefined)
  return turn
}

async function readOne(
  bytes: Uint8Array,
  limits: BrainLimits.Limits,
  signal?: AbortSignal,
): Promise<Read | ReadRefusal> {
  const decoded = budget(limits.streams)
  decoding.budget = decoded
  const result = await open(bytes, limits, decoded, signal).finally(() => {
    decoding.budget = undefined
  })
  return decoded.over ? refuse("too-large", TOO_LARGE) : result
}

async function open(bytes: Uint8Array, limits: BrainLimits.Limits, decoded: BrainLimits.Budget, signal?: AbortSignal) {
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const opened = await getDocumentProxy(bytes.slice(), OPTIONS).then(
    (document) => ({ document }),
    (error: unknown) => ({ error }),
  )
  if ("error" in opened)
    return typeof opened.error === "object" &&
      opened.error !== null &&
      "name" in opened.error &&
      opened.error.name === "PasswordException"
      ? refuse(
          "encrypted",
          "This file is password protected. Vector doesn't ask for document passwords; add an unprotected copy.",
        )
      : refuse("invalid", "This PDF is damaged and could not be read.")
  const ocr = await BrainOcr.open(bytes, limits, signal)
  return extract(opened.document, limits, decoded, signal, ocr)
    .catch(() => refuse("invalid", "This PDF is damaged and could not be read."))
    .finally(async () => {
      await ocr?.close()
      await opened.document.loadingTask.destroy()
    })
}

// pdf.js decodes a content stream, a font or an object stream whole before it reads one, so a small file can ask for
// gigabytes, and those bytes live outside the JavaScript heap where no worker limit reaches them. Whatever the file
// says about its streams, every decoder that grows (Flate, LZW, run length, the two ASCII ones, predictors and
// decryption) grows its buffer through `DecodeStream.ensureBuffer`, so the growth is counted there against the PDF
// being read, and past `limits.streams` growing throws and the read is refused. A page's contents joined into one
// stream are not counted again, since each part already was.
const decoding: { budget?: BrainLimits.Budget } = {}

const ensureBuffer = DecodeStream.prototype.ensureBuffer
DecodeStream.prototype.ensureBuffer = function (this: DecodeStream, requested: number) {
  const held = this.buffer.byteLength
  if (requested > held && decoding.budget && !(this instanceof StreamsSequenceStream)) {
    // pdf.js grows to its minimum doubled until the request fits.
    const minimum = Math.max(1, this.minBufferLength)
    const size = minimum * 2 ** Math.max(0, Math.ceil(Math.log2(requested / minimum)))
    if (!decoding.budget.take(size - held)) throw new RangeError(TOO_LARGE)
  }
  return ensureBuffer.call(this, requested)
}

// pdf.js would first inflate a Flate or Brotli stream through the platform's DecompressionStream, gathering all of its
// output before anything could count it. Declining that sends every stream through the counted decoders instead.
DecodeStream.prototype.asyncGetBytesFromDecompressionStream = async function (this: DecodeStream) {
  this.stream.reset()
  return {
    decompressed: null,
    compressed: (this.stream.isAsync && (await this.stream.asyncGetBytes())) || this.stream.getBytes(),
  }
}

// These decoders build their whole output in buffers of their own, which the count above never sees, and every one
// of them but Brotli exists for pictures, which are never read. A stream filtered by one is read as empty.
const UNCOUNTED = new Set([
  "DCT",
  "DCTDecode",
  "JPX",
  "JPXDecode",
  "JBIG2Decode",
  "CCF",
  "CCITTFaxDecode",
  "BrotliDecode",
])
const makeFilter = Parser.prototype.makeFilter
Parser.prototype.makeFilter = function (
  this: Parser,
  stream: unknown,
  name: string,
  length: number | null,
  params: unknown,
  cipher?: unknown,
) {
  // pdf.js reads a stream it is told is empty as no bytes at all.
  return makeFilter.call(this, stream, name, UNCOUNTED.has(name) ? 0 : length, params, cipher)
}

// Nothing is drawn, so what pdf.js builds only to draw is never built. Its size comes from what the file states rather
// than from bytes anything decodes: a sampled function's table holds the product of its /Size, a stitching function
// builds every function it lists again each time it is listed, and a mesh shading keeps a point for every few bits of
// its data and hundreds for every patch. So a function (a tint, a gradient's colours, a transfer curve) leaves its
// output as it found it, and every shading is refused, which pdf.js takes as one it cannot read and leaves out.
PDFFunctionFactory.prototype.create = () => () => undefined
Pattern.parseShading = () => {
  throw new Error("Shadings are never read.")
}

/** What pdf.js keeps for one code of a range, counted against the cap: about one map entry and a short string. */
const ENTRY = 64

// A font's character map and a composite font's widths give a range of codes in a few bytes, and pdf.js stores every
// code in the range one by one, so a small file can ask for hundreds of millions. Text needs both, so each range is
// counted against the decoders' cap before pdf.js stores it, and past the cap the read is refused.
const ranged = <T>(map: (this: CMap, low: number, high: number, destination: T) => void) =>
  function (this: CMap, low: number, high: number, destination: T) {
    if (decoding.budget && high >= low && !decoding.budget.take((high - low + 1) * ENTRY))
      throw new RangeError(TOO_LARGE)
    return map.call(this, low, high, destination)
  }
CMap.prototype.mapCidRange = ranged(CMap.prototype.mapCidRange)
CMap.prototype.mapBfRange = ranged(CMap.prototype.mapBfRange)

const extractWidths = PartialEvaluator.prototype.extractWidths
PartialEvaluator.prototype.extractWidths = function (this: PartialEvaluator, dict, descriptor, properties) {
  const codes = properties.composite
    ? widthRanges(this, dict.get("W"), 1) + (properties.vertical ? widthRanges(this, dict.get("W2"), 3) : 0)
    : 0
  if (decoding.budget && codes > 0 && !decoding.budget.take(codes * ENTRY)) throw new RangeError(TOO_LARGE)
  return extractWidths.call(this, dict, descriptor, properties)
}

// The codes a composite font's /W (one value each) or /W2 (three) gives by range, read the way pdf.js reads them:
// `first [values…]` lists its codes one by one, which the file's own bytes bound, while `first last values` gives
// every code from first to last.
function widthRanges(evaluator: PartialEvaluator, list: unknown, values: number) {
  if (!Array.isArray(list)) return 0
  const state = { at: 0, codes: 0 }
  while (state.at < list.length) {
    const first = evaluator.xref.fetchIfRef(list[state.at])
    const last = evaluator.xref.fetchIfRef(list[state.at + 1])
    if (typeof first !== "number" || !Number.isInteger(first)) break
    if (Array.isArray(last)) {
      state.at += 2
      continue
    }
    if (typeof last !== "number" || !Number.isInteger(last)) break
    state.codes += Math.max(0, last - first + 1)
    state.at += 2 + values
  }
  return state.codes
}

async function extract(
  document: Document,
  limits: BrainLimits.Limits,
  decoded: BrainLimits.Budget,
  signal?: AbortSignal,
  ocr?: BrainOcr.Session,
): Promise<Read> {
  const warnings = new Set<BrainSchema.DocumentWarning>()
  const meta = await document.getMetadata().catch(() => undefined)
  const info: Record<string, unknown> =
    typeof meta?.info === "object" && meta.info !== null ? (meta.info as Record<string, unknown>) : {}
  if (info.EncryptFilterName) warnings.add("encrypted")
  const outline = await headings(document)
  const count = Math.min(document.numPages, limits.pages)
  if (document.numPages > count) warnings.add("truncated")
  const pages: Line[][] = []
  const unread: number[] = []
  const links: string[] = []
  const recognized = new Map<number, readonly Draft[]>()
  const state = { chars: 0 }
  // Once the decoders are over their cap the read is refused, and once it is told to stop it is not wanted, so no
  // further page is opened.
  for (let number = 1; number <= count && !decoded.over && !signal?.aborted; number++) {
    const page = await document.getPage(number).catch(() => undefined)
    const content = await page?.getTextContent().catch(() => undefined)
    const [left, bottom, right, top] = (page?.view ?? []) as number[]
    if (!page || !content || ![left, bottom, right, top].every((edge) => Number.isFinite(edge))) {
      unread.push(number)
      pages.push([])
      page?.cleanup()
      continue
    }
    const items = content.items.flatMap((item) => ("str" in item && item.str.trim() ? [item] : []))
    const kept = items.filter((item) => {
      const [, , c, d, x, y] = item.transform as number[]
      const size = Math.hypot(c!, d!)
      return size >= 2 && x! <= right! && x! + item.width >= left! && y! >= bottom! && y! <= top!
    })
    const visible = kept.reduce((sum, item) => sum + item.str.replace(/\s/g, "").length, 0)
    if (visible < SCANNED) {
      const result = await ocr?.read(number)
      if (result?.type === "read") {
        warnings.add("ocr")
        if (result.truncated) warnings.add("truncated")
        recognized.set(
          number,
          BrainText.read(result.text).drafts.map((draft) => ({ ...draft, page: number })),
        )
        state.chars += result.text.length
      } else {
        unread.push(number)
        warnings.add("ocr-incomplete")
      }
      pages.push([])
      page.cleanup()
      if (state.chars > limits.chars) {
        warnings.add("truncated")
        break
      }
      continue
    }
    // Weight lives with the font, which pdf.js resolves while building a page's drawing operations. Fonts are shared
    // across pages, so that only runs on a page that brings one not seen before.
    const fonts = [...new Set(kept.map((item) => item.fontName))]
    if (fonts.some((font) => !page.commonObjs.has(font))) await page.getOperatorList().catch(() => undefined)
    const weight = new Map(
      fonts.map((font) => [
        font,
        page.commonObjs.has(font) && (page.commonObjs.get(font) as { bold?: boolean } | undefined)?.bold === true,
      ]),
    )
    const budget = { left: limits.pageChars }
    const placed = kept.flatMap((item): Item[] => {
      if (budget.left <= 0) return []
      budget.left -= item.str.length
      const [, , c, d, x, y] = item.transform as number[]
      return [
        {
          text: item.str.slice(0, Math.max(0, budget.left + item.str.length)),
          x: Math.max(left!, x!),
          y: y!,
          end: Math.min(right!, x! + item.width),
          size: Math.hypot(c!, d!),
          bold: weight.get(item.fontName) ?? false,
          mono: content.styles[item.fontName]?.fontFamily === "monospace",
        },
      ]
    })
    if (budget.left <= 0) warnings.add("truncated")
    const lines = baselines(placed, number, top!, bottom!)
    // Each dropped run flags the line nearest it, so the passage it was hidden in is held.
    const shown = new Set(kept)
    for (const item of items.filter((item) => !shown.has(item))) {
      const y = (item.transform as number[])[5]!
      const nearest = lines.reduce<Line | undefined>(
        (best, line) => (!best || Math.abs(line.y - y) < Math.abs(best.y - y) ? line : best),
        undefined,
      )
      if (nearest) nearest.hidden = true
    }
    pages.push(lines)
    const annotations = await page.getAnnotations().catch(() => [])
    links.push(
      ...annotations.flatMap((annotation: { subtype?: string; url?: string }) =>
        annotation.subtype === "Link" && annotation.url ? [annotation.url] : [],
      ),
    )
    page.cleanup()
    state.chars += placed.reduce((sum, item) => sum + item.text.length, 0)
    if (limits.yield) await new Promise((resolve) => setImmediate(resolve))
    if (state.chars > limits.chars) {
      warnings.add("truncated")
      break
    }
  }
  const body = mode(pages.flat())
  const running = repeated(pages)
  const drafts = pages.flatMap((lines, index) => {
    const number = index + 1
    const ocr = recognized.get(number)
    if (ocr) return ocr
    const kept = lines.filter((line) => !running.has(line) && !pageNumber(line))
    const blocks = layout(
      columns(kept),
      body,
      outline.filter((heading) => heading.page === number),
      warnings,
    )
    const missing = outline.filter((heading) => heading.page === number && !blocks.matched.has(heading))
    return [
      ...missing.map(
        (heading): Draft => ({ type: "heading", level: heading.level, text: heading.title, page: number }),
      ),
      ...blocks.drafts.map((draft) => ({ ...draft, page: number })),
    ]
  })
  const title =
    typeof info.Title === "string" &&
    info.Title.trim() &&
    !/^(?:untitled|microsoft word - |.*\.(?:docx?|pdf|pptx?)$)/i.test(info.Title.trim())
      ? info.Title.trim()
      : undefined
  return {
    type: "read",
    format: "pdf",
    ...(title ? { title } : {}),
    pages: document.numPages,
    unread,
    drafts,
    links,
    warnings: [...warnings],
  }
}

// The outline's entries with the pages they point to, nested entries a level deeper. An entry whose destination cannot
// be resolved is left out.
async function headings(document: Document) {
  const outline = await document.getOutline().catch(() => null)
  const flat: { title: string; dest: unknown; level: number }[] = []
  const visit = (items: readonly { title: string; dest: unknown; items: readonly unknown[] }[], level: number) => {
    for (const item of items) {
      if (flat.length >= 2_000 || level > 6) return
      flat.push({ title: item.title, dest: item.dest, level })
      visit(item.items as typeof items, level + 1)
    }
  }
  visit(outline ?? [], 1)
  const resolved = await Promise.all(
    flat.map(async (item): Promise<Heading | undefined> => {
      const destination =
        typeof item.dest === "string" ? await document.getDestination(item.dest).catch(() => null) : item.dest
      const target = Array.isArray(destination) ? destination[0] : undefined
      const index =
        typeof target === "number"
          ? target
          : typeof target === "object" && target !== null
            ? await document.getPageIndex(target as Parameters<Document["getPageIndex"]>[0]).catch(() => -1)
            : -1
      const title = item.title.replace(/\s+/g, " ").trim()
      return index >= 0 && title ? { title, page: index + 1, level: item.level } : undefined
    }),
  )
  return resolved.filter((heading): heading is Heading => !!heading)
}

// Text runs on one baseline (within half a font size) are one line; runs further apart than twice a space's width
// are separate cells, which is what tables and columns are found from.
function baselines(items: readonly Item[], page: number, top: number, bottom: number): Line[] {
  const sorted = items.toSorted((a, b) => b.y - a.y || a.x - b.x)
  const groups = sorted.reduce<{ y: number; size: number; items: Item[] }[]>((all, item) => {
    const last = all.at(-1)
    if (last && Math.abs(last.y - item.y) <= 0.5 * Math.max(last.size, item.size)) {
      last.items.push(item)
      last.size = Math.max(last.size, item.size)
    } else all.push({ y: item.y, size: item.size, items: [item] })
    return all
  }, [])
  return groups.map((group) => {
    const runs = group.items.toSorted((a, b) => a.x - b.x)
    const cells = runs.reduce<{ x: number; end: number; text: string; size: number }[]>((all, run) => {
      const last = all.at(-1)
      const gap = last ? run.x - last.end : Infinity
      if (last && gap <= 0.55 * Math.max(run.size, last.size)) {
        const space = gap > 0.1 * run.size && !/\s$/.test(last.text) && !/^\s/.test(run.text) ? " " : ""
        all[all.length - 1] = { ...last, end: Math.max(last.end, run.end), text: `${last.text}${space}${run.text}` }
      } else all.push({ x: run.x, end: run.end, text: run.text, size: run.size })
      return all
    }, [])
    const chars = runs.reduce((sum, run) => sum + run.text.length, 0)
    const size = runs.reduce((sum, run) => sum + run.size * run.text.length, 0) / Math.max(1, chars)
    return {
      page,
      y: runs[0]!.y,
      x: cells[0]!.x,
      end: cells.at(-1)!.end,
      size,
      text: cells.map((cell) => cell.text.trim()).join(" "),
      cells: cells.map((cell) => ({ x: cell.x, end: cell.end, text: cell.text.trim() })),
      bold: runs.every((run) => run.bold),
      mono: runs.every((run) => run.mono),
      code: runs.filter((run) => run.mono && !runs.every((other) => other.mono)).map((run) => run.text.trim()),
      top: top - runs[0]!.y,
      bottom: runs[0]!.y - bottom,
      hidden: false,
    }
  })
}

// The body text size: the size most characters are set in.
function mode(lines: readonly Line[]) {
  const counts = lines.reduce(
    (all, line) =>
      all.set(Math.round(line.size * 2) / 2, (all.get(Math.round(line.size * 2) / 2) ?? 0) + line.text.length),
    new Map<number, number>(),
  )
  return [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? 11
}

// Lines in the top or bottom 8% of the page (above or below where body text starts on a page with margins) that
// repeat, digits aside, at about the same height (±3 pt) on at least half of the pages with text: running headers and
// footers.
function repeated(pages: readonly (readonly Line[])[]) {
  const read = pages.filter((lines) => lines.length > 0).length
  if (read < 2) return new Set<Line>()
  const margin = (line: Line) =>
    line.top < 0.08 * (line.top + line.bottom) || line.bottom < 0.08 * (line.top + line.bottom)
  const key = (line: Line) => line.text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim()
  const candidates = pages
    .flatMap((lines) => lines.filter(margin))
    .map((line) => ({ line, key: key(line), band: Math.floor(line.y / 3) }))
  // Pages on which each text appears, by 3 pt band; a line counts the pages in its band and the two beside it.
  const seen = new Map<string, Set<number>>()
  for (const candidate of candidates) {
    const at = `${candidate.key}\0${candidate.band}`
    seen.set(at, (seen.get(at) ?? new Set()).add(candidate.line.page))
  }
  const needed = Math.max(2, Math.ceil(read / 2))
  return new Set(
    candidates
      .filter(
        (candidate) =>
          new Set([-1, 0, 1].flatMap((offset) => [...(seen.get(`${candidate.key}\0${candidate.band + offset}`) ?? [])]))
            .size >= needed,
      )
      .map((candidate) => candidate.line),
  )
}

function pageNumber(line: Line) {
  const margin = line.top < 0.08 * (line.top + line.bottom) || line.bottom < 0.08 * (line.top + line.bottom)
  return margin && /^(?:page\s+)?(?:\d{1,4}|[ivxlc]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?$/i.test(line.text.trim())
}

const GUTTER = 200

// Two columns: a vertical band in the middle of the text that almost no line crosses, with prose-width text on both
// sides of it. Each run of two-column lines is read left column first; a line across the band (a title, a figure
// caption) ends the run.
function columns(lines: readonly Line[]): Line[] {
  if (lines.length < 4) return [...lines]
  const left = Math.min(...lines.map((line) => line.x))
  const right = Math.max(...lines.map((line) => line.end))
  const width = right - left
  if (width < 200) return [...lines]
  const covers = (line: Line, x: number) => line.cells.some((cell) => cell.x - 2 < x && x < cell.end + 2)
  // The middle 40% of the text is tried at a fixed number of points, however wide the file says its page is.
  const candidates = Array.from({ length: GUTTER }, (_, index) => left + 0.3 * width + (index * 0.4 * width) / GUTTER)
  const gutter = candidates
    .map((x) => ({
      x,
      crossing: lines.filter((line) => covers(line, x)).length,
      offset: Math.abs(x - (left + width / 2)),
    }))
    .toSorted((a, b) => a.crossing - b.crossing || a.offset - b.offset)[0]!
  const sides = lines.map((line) => ({
    left: line.cells.filter((cell) => cell.end <= gutter.x),
    right: line.cells.filter((cell) => cell.x >= gutter.x),
  }))
  const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
  const leftWidths = sides.flatMap((side) => side.left.map((cell) => cell.end - cell.x))
  const rightWidths = sides.flatMap((side) => side.right.map((cell) => cell.end - cell.x))
  const twoColumns =
    gutter.crossing <= 0.15 * lines.length &&
    sides.filter((side) => side.left.length > 0).length >= 0.3 * lines.length &&
    sides.filter((side) => side.right.length > 0).length >= 0.3 * lines.length &&
    median(leftWidths) >= 0.25 * width &&
    median(rightWidths) >= 0.25 * width
  if (!twoColumns) return [...lines]
  const part = (line: Line, cells: readonly Cell[]): Line => ({
    ...line,
    x: cells[0]!.x,
    end: cells.at(-1)!.end,
    cells,
    text: cells.map((cell) => cell.text).join(" "),
  })
  const out: Line[] = []
  const buffer = { left: [] as Line[], right: [] as Line[] }
  const flush = () => {
    out.push(...buffer.left, ...buffer.right)
    buffer.left = []
    buffer.right = []
  }
  for (const [index, line] of lines.entries()) {
    if (covers(line, gutter.x)) {
      flush()
      out.push(line)
      continue
    }
    const side = sides[index]!
    if (side.left.length > 0) buffer.left.push(part(line, side.left))
    if (side.right.length > 0) buffer.right.push(part(line, side.right))
  }
  flush()
  return out
}

/** The most spaces a code line is indented by, however far right the file sets it. */
const INDENT = 64

const BULLET = /^(?:[•◦▪‣·●○■□➢►–—*-]|\(?(?:\d{1,3}|[a-z]|[ivx]{1,5})[.)])\s+/i
const NUMBERED = /^\d+(?:\.\d+)*\s+\p{Lu}/u

// Lines of one page, in reading order, into blocks.
function layout(
  lines: readonly Line[],
  body: number,
  outline: readonly Heading[],
  warnings: Set<BrainSchema.DocumentWarning>,
) {
  const drafts: Draft[] = []
  const matched = new Set<Heading>()
  const sizes = [
    ...new Set(lines.filter((line) => line.size >= 1.15 * body).map((line) => Math.round(line.size * 2) / 2)),
  ].toSorted((a, b) => b - a)
  const normal = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  const entry = (line: Line) => outline.find((item) => !matched.has(item) && normal(item.title) === normal(line.text))
  const heading = (line: Line) => {
    const listed = entry(line)
    if (listed) return listed.level
    // A contents page's "3.2 Retries ........ 14" names a heading; it is not one.
    if (
      line.text.length >= 120 ||
      /[.:;,]$/.test(line.text) ||
      /(?:\.\s?){3,}\s*\d+$/.test(line.text) ||
      BULLET.test(line.text) ||
      line.cells.length >= 3 ||
      line.mono
    )
      return undefined
    const numbered = NUMBERED.test(line.text) ? line.text.match(/^\d+(?:\.\d+)*/)![0].split(".").length : undefined
    if (line.size >= 1.15 * body) return numbered ?? sizes.indexOf(Math.round(line.size * 2) / 2) + 1
    if (line.bold && line.size >= body - 0.5) return numbered ?? sizes.length + 1
    return numbered
  }
  const hidden = (group: readonly Line[]) => (group.some((line) => line.hidden) ? { hidden: true } : {})
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const level = heading(line)
    if (level !== undefined) {
      const listed = entry(line)
      if (listed) matched.add(listed)
      drafts.push({ type: "heading", level: Math.min(6, level), text: line.text, ...hidden([line]) })
      continue
    }
    const near = (a: Line, b: Line, factor: number) => a.y - b.y > 0 && a.y - b.y <= factor * Math.max(a.size, b.size)
    const table = rows(lines, index, near)
    if (table.length >= 3) {
      const starts = table[0]!.cells.map((cell) => cell.x)
      const grid = table.map((row) =>
        starts.map((start, column) =>
          row.cells
            .filter((cell) => nearest(starts, cell.x) === column)
            .map((cell) => cell.text)
            .join(" "),
        ),
      )
      const header = table[0]!.bold || grid[0]!.every((cell) => cell && cell.length <= 30 && !/\d/.test(cell))
      drafts.push({
        type: "table",
        header: header ? grid[0]! : [],
        rows: grid.slice(header ? 1 : 0),
        confidence: 0.6,
        ...hidden(table),
      })
      warnings.add("tables-approximate")
      index += table.length - 1
      continue
    }
    if (line.mono) {
      const stop = lines.findIndex((other, at) => at > index && !other.mono)
      const group = lines.slice(index, stop < 0 ? lines.length : stop)
      const indent = Math.min(...group.map((other) => other.x))
      drafts.push({
        type: "code",
        text: group
          .map(
            (other) =>
              `${" ".repeat(Math.min(INDENT, Math.max(0, Math.round((other.x - indent) / (0.6 * other.size)))))}${other.text}`,
          )
          .join("\n"),
        ...hidden(group),
      })
      index += group.length - 1
      continue
    }
    if (BULLET.test(line.text)) {
      const items: { text: string; depth: number; lines: Line[] }[] = []
      const ordered = /^\(?(?:\d{1,3}|[a-z]|[ivx]{1,5})[.)]\s/i.test(line.text)
      const margin = line.x
      let at = index
      for (; at < lines.length; at++) {
        const current = lines[at]!
        const previous = lines[at - 1]
        if (at > index && (!previous || !near(previous, current, 1.8) || heading(current) !== undefined)) break
        if (BULLET.test(current.text))
          items.push({
            text: current.text.replace(BULLET, ""),
            depth: Math.max(0, Math.round((current.x - margin) / 18)),
            lines: [current],
          })
        else if (items.length > 0 && current.x > items.at(-1)!.lines[0]!.x + 2) {
          const last = items.at(-1)!
          items[items.length - 1] = {
            ...last,
            text: BrainText.join([last.text, current.text]),
            lines: [...last.lines, current],
          }
        } else break
      }
      drafts.push({
        type: "list",
        ordered,
        items: items.map((item) => ({
          text: item.text,
          depth: item.depth,
          code: item.lines.flatMap((other) => other.code),
        })),
        ...hidden(items.flatMap((item) => item.lines)),
      })
      index = at - 1
      continue
    }
    const group = [line]
    for (let at = index + 1; at < lines.length; at++) {
      const current = lines[at]!
      const previous = group.at(-1)!
      if (
        !near(previous, current, 1.6) ||
        Math.abs(current.size - previous.size) > 0.5 ||
        heading(current) !== undefined ||
        BULLET.test(current.text) ||
        current.mono ||
        rows(lines, at, near).length >= 3
      )
        break
      group.push(current)
    }
    drafts.push({
      type: "paragraph",
      text: BrainText.join(group.map((other) => other.text)),
      code: group.flatMap((other) => other.code),
      ...hidden(group),
    })
    index += group.length - 1
  }
  return { drafts, matched }
}

// The table starting at a line: three or more close lines, each of three or more cells, whose cells start where the
// first line's do (within 3 pt).
function rows(lines: readonly Line[], from: number, near: (a: Line, b: Line, factor: number) => boolean) {
  const first = lines[from]!
  if (first.cells.length < 3) return []
  const starts = first.cells.map((cell) => cell.x)
  const table = [first]
  for (let at = from + 1; at < lines.length; at++) {
    const line = lines[at]!
    if (
      !near(table.at(-1)!, line, 2.5) ||
      line.cells.length < 3 ||
      !line.cells.every((cell) => starts.some((start) => Math.abs(start - cell.x) <= 3))
    )
      break
    table.push(line)
  }
  return table
}

function nearest(starts: readonly number[], x: number) {
  return starts.reduce((best, start, index) => (Math.abs(start - x) < Math.abs(starts[best]! - x) ? index : best), 0)
}
