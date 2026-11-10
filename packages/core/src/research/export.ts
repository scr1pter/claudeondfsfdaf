export * as ResearchExport from "./export"

import { strToU8, zipSync } from "fflate"
import { marked, type Token, type Tokens } from "marked"
import { setTimeout } from "node:timers/promises"

export type Format = "docx" | "pdf"
export const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
} as const

// Exports use saved report text only. No converter, URL, image or external relationship is opened.
const LIMIT = { bytes: 4 * 1024 * 1024, blocks: 10_000, pages: 300, columns: 20 }

export type Block =
  | { readonly kind: "heading"; readonly text: string; readonly level: number }
  | { readonly kind: "paragraph" | "quote" | "code" | "list"; readonly text: string }
  | { readonly kind: "table"; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: "rule" }

export function blocks(markdown: string): Block[] {
  if (new TextEncoder().encode(markdown).length > LIMIT.bytes)
    throw new Error("This report is too large to export as Word or PDF. Export Markdown instead.")
  // Marked treats footnotes as link definitions, which would otherwise discard the report's verified quotes.
  // Only Vector's unescaped N# references are rewritten; quoted/untrusted definitions remain inert.
  const printable = markdown
    .replace(/^\[\^(N\d+)\]:[ \t]*(.*)$/gm, (_, id: string, quote: string) => `\nEvidence ${id}: ${quote}\n`)
    .replace(/(?<!\\)\[\^(N\d+)\]/g, (_, id: string) => `\\[${id}\\]`)
  const result = parse(marked.lexer(printable, { gfm: true }))
  if (result.length > LIMIT.blocks)
    throw new Error("This report has too many sections to export as Word or PDF. Export Markdown instead.")
  return result
}

export async function render(markdown: string, format: Format) {
  const content = blocks(markdown)
  return { bytes: format === "docx" ? word(content) : await pdf(content), type: MIME[format] }
}

function parse(tokens: readonly Token[]): Block[] {
  return tokens.flatMap((token): Block[] => {
    if (token.type === "space" || token.type === "def") return []
    if (token.type === "heading") return [{ kind: "heading", level: token.depth, text: text(token.tokens ?? []) }]
    if (token.type === "paragraph" || token.type === "text")
      return [{ kind: "paragraph", text: token.tokens ? text(token.tokens) : token.text }]
    if (token.type === "code") return [{ kind: "code", text: token.text }]
    if (token.type === "blockquote")
      return parse(token.tokens ?? []).map((item) => ("text" in item ? { kind: "quote", text: item.text } : item))
    if (token.type === "list")
      return (token as Tokens.List).items.flatMap((item, index) => {
        const prefix = token.ordered ? `${Number(token.start) + index}. ` : "• "
        const children = parse(item.tokens)
        return children.map((child, at) =>
          "text" in child ? { kind: "list" as const, text: (at === 0 ? prefix : "  ") + child.text } : child,
        )
      })
    if (token.type === "table") {
      if (token.header.length > LIMIT.columns)
        throw new Error("This report's table has too many columns for Word or PDF. Export Markdown instead.")
      return [
        {
          kind: "table",
          rows: [(token as Tokens.Table).header, ...(token as Tokens.Table).rows].map((row) =>
            row.map((cell) => text(cell.tokens)),
          ),
        },
      ]
    }
    if (token.type === "hr") return [{ kind: "rule" }]
    // Raw HTML is literal text, never executable markup. Image addresses are deliberately absent from exports.
    if (token.type === "html") return [{ kind: "paragraph", text: token.text }]
    return []
  })
}

function text(tokens: readonly Token[]): string {
  return tokens
    .map((token): string => {
      if (token.type === "image") return token.text ? `[Image: ${token.text}]` : "[Image omitted]"
      if (token.type === "link") {
        const label = text(token.tokens ?? [])
        return /^https?:\/\//i.test(token.href) && label !== token.href ? `${label} (${token.href})` : label
      }
      if (token.type === "br") return "\n"
      if ("tokens" in token && Array.isArray(token.tokens)) return text(token.tokens)
      return "text" in token && typeof token.text === "string" ? decode(token.text) : token.raw
    })
    .join("")
}

function decode(input: string) {
  return input
    .replace(
      /&(?:amp|lt|gt|quot|apos|#39|#x27);/g,
      (entity) =>
        ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&#x27;": "'" })[
          entity
        ]!,
    )
    .replace(/&#(\d{1,7});|&#x([a-f\d]{1,6});/gi, (raw, decimal: string | undefined, hex: string | undefined) => {
      const point = decimal ? Number(decimal) : Number.parseInt(hex!, 16)
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : raw
    })
}

function xml(input: string) {
  return input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function paragraph(input: string, style = "Normal") {
  const runs = input
    .split("\n")
    .map((line, index) => `${index ? "<w:r><w:br/></w:r>" : ""}<w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r>`)
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs.join("")}</w:p>`
}

function word(content: readonly Block[]) {
  const body = content
    .map((block) => {
      if (block.kind === "rule") return paragraph("────────────────────")
      if (block.kind === "table")
        return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="C8CED8"/>`).join("")}</w:tblBorders></w:tblPr>${block.rows.map((row, index) => `<w:tr>${index === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(5000 / Math.max(1, row.length))}" w:type="pct"/>${index === 0 ? '<w:shd w:fill="EEF1F5"/>' : ""}</w:tcPr>${paragraph(cell, index === 0 ? "TableHeader" : "Normal")}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`
      return paragraph(
        block.text,
        block.kind === "heading"
          ? `Heading${Math.min(block.level, 3)}`
          : block.kind === "code"
            ? "Code"
            : block.kind === "quote"
              ? "Quote"
              : "Normal",
      )
    })
    .join("")
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const styles = [
    ["Normal", "Research body", 22, "", ""],
    ["Heading1", "Heading 1", 40, "<w:b/>", '<w:keepNext/><w:spacing w:before="320" w:after="160"/>'],
    ["Heading2", "Heading 2", 30, "<w:b/>", '<w:keepNext/><w:spacing w:before="260" w:after="120"/>'],
    ["Heading3", "Heading 3", 25, "<w:b/>", '<w:keepNext/><w:spacing w:before="220" w:after="100"/>'],
    ["Quote", "Quote", 22, "<w:i/>", '<w:ind w:left="360"/>'],
    ["Code", "Code", 19, '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>', '<w:shd w:fill="F4F5F7"/>'],
    ["TableHeader", "Table header", 22, "<w:b/>", ""],
  ]
    .map(
      ([id, name, size, run, para]) =>
        `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${id !== "Normal" ? '<w:basedOn w:val="Normal"/>' : ""}<w:pPr>${para}</w:pPr><w:rPr><w:sz w:val="${size}"/>${run}</w:rPr></w:style>`,
    )
    .join("")
  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        `${declaration}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
      ),
      "word/_rels/document.xml.rels": strToU8(
        `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
      "word/styles.xml": strToU8(
        `${declaration}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Inter" w:hAnsi="Inter"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="280" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${styles}</w:styles>`,
      ),
    },
    { level: 6 },
  )
}

async function pdf(content: readonly Block[]) {
  const { PDFDocument, rgb } = await import("pdf-lib")
  const fontkit = await import("@pdf-lib/fontkit")
  const { data } = await import("./assets/inter")
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit.default)
  // Inter is variable: fontkit's subset can retain the text mapping while dropping visible glyph outlines.
  // Embed its complete original font so both PDF extraction and actual page rendering preserve the evidence.
  const font = await document.embedFont(Buffer.from(data, "base64"), { subset: false })
  const charset = new Set(font.getCharacterSet())
  const missing = [
    ...new Set([
      ...content
        .flatMap((block) => (block.kind === "table" ? block.rows.flat() : "text" in block ? [block.text] : []))
        .join(""),
    ]),
  ].filter((character) => !/\s/.test(character) && !charset.has(character.codePointAt(0)!))
  if (missing.length)
    throw new Error(
      `PDF's bundled font cannot display ${missing
        .slice(0, 5)
        .map((character) => `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`)
        .join(", ")}. Export Word or Markdown to preserve this text.`,
    )
  document.setTitle(content.find((block) => block.kind === "heading")?.text ?? "Vector research")
  document.setCreator("Vector")
  const size = { width: 595.28, height: 841.89, margin: 52 }
  const width = size.width - size.margin * 2
  const state = { page: document.addPage([size.width, size.height]), y: size.height - size.margin }
  const color = rgb(0.13, 0.16, 0.21)
  const page = () => {
    if (document.getPageCount() >= LIMIT.pages)
      throw new Error("This report exceeds 300 PDF pages. Export Word or Markdown instead.")
    state.page = document.addPage([size.width, size.height])
    state.y = size.height - size.margin
  }
  const room = (height: number) => {
    if (state.y - height < size.margin + 14) page()
  }
  const wrapped = new Map<string, string[]>()
  const lines = (input: string, max: number, point: number) => {
    const key = `${max}:${point}:${input}`
    const cached = wrapped.get(key)
    if (cached) return cached
    const result = input
      .replace(/\t/g, "    ")
      .split("\n")
      .flatMap((line) => {
        const rows = [""]
        for (const word of line.split(/(?<=\s)/u)) {
          if (font.widthOfTextAtSize(rows.at(-1)! + word, point) <= max) {
            rows[rows.length - 1] += word
            continue
          }
          if (rows.at(-1)) rows.push("")
          if (font.widthOfTextAtSize(word, point) <= max) {
            rows[rows.length - 1] += word
            continue
          }
          for (const character of word) {
            if (rows.at(-1) && font.widthOfTextAtSize(rows.at(-1)! + character, point) > max) rows.push("")
            rows[rows.length - 1] += character
          }
        }
        return rows.map((row) => row.trimEnd())
      })
    wrapped.set(key, result)
    return result
  }
  for (const block of content) {
    if (block.kind === "rule") {
      room(20)
      state.page.drawLine({
        start: { x: size.margin, y: state.y - 6 },
        end: { x: size.width - size.margin, y: state.y - 6 },
        color: rgb(0.8, 0.82, 0.86),
        thickness: 0.7,
      })
      state.y -= 20
      continue
    }
    if (block.kind === "table") {
      const columns = Math.max(1, ...block.rows.map((row) => row.length))
      const cell = width / columns
      for (const [index, row] of block.rows.entries()) {
        if (index > 0 && index % 20 === 0) await setTimeout(0)
        const cells = Array.from({ length: columns }, (_, column) => lines(row[column] ?? "", cell - 12, 9))
        const count = Math.max(1, ...cells.map((item) => item.length))
        for (let from = 0; from < count; ) {
          room(26)
          const take = Math.max(1, Math.min(count - from, Math.floor((state.y - size.margin - 26) / 13)))
          const height = take * 13 + 12
          for (let column = 0; column < columns; column++) {
            state.page.drawRectangle({
              x: size.margin + column * cell,
              y: state.y - height,
              width: cell,
              height,
              borderColor: rgb(0.8, 0.82, 0.86),
              borderWidth: 0.5,
              ...(index === 0 ? { color: rgb(0.93, 0.95, 0.97) } : {}),
            })
            cells[column].slice(from, from + take).forEach((line, at) =>
              state.page.drawText(line, {
                x: size.margin + column * cell + 6,
                y: state.y - 15 - at * 13,
                font,
                size: 9,
                color,
              }),
            )
          }
          state.y -= height
          from += take
        }
      }
      state.y -= 10
      continue
    }
    const point =
      block.kind === "heading"
        ? block.level === 1
          ? 24
          : block.level === 2
            ? 16
            : 12
        : block.kind === "code"
          ? 9
          : 10.5
    const leading = point * 1.45
    const indent = block.kind === "quote" || block.kind === "list" ? 12 : 0
    const wrapped = lines(block.text, width - indent, point)
    if (block.kind === "heading") room(leading * 3)
    for (const line of wrapped) {
      room(leading)
      state.page.drawText(line, { x: size.margin + indent, y: state.y - point, font, size: point, color })
      state.y -= leading
    }
    state.y -= block.kind === "heading" ? 10 : 7
  }
  for (const [index, item] of document.getPages().entries())
    item.drawText(`Vector research  |  ${index + 1} / ${document.getPageCount()}`, {
      x: size.margin,
      y: 27,
      font,
      size: 8,
      color: rgb(0.45, 0.48, 0.53),
    })
  return document.save()
}
