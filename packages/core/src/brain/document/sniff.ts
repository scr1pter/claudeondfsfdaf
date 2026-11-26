export * as BrainSniff from "./sniff"

import type { BrainSchema } from "../schema"
import { refuse, type BrainLimits } from "./limits"
import { BrainOoxml } from "./ooxml"
import type { Input, ReadRefusal } from "./read"
import { SECRET_FILE } from "./secret-file"

// Which reader a file goes to: its first bytes decide, and its name only when the bytes say nothing (text formats).
// A file is never read as something its bytes contradict, so a renamed executable or archive is refused, not parsed.

export { SECRET_FILE } from "./secret-file"

export type Sniffed = {
  readonly type: "format"
  readonly format: Exclude<BrainSchema.Format, "openapi">
  readonly delimiter?: string
}

type TextFormat = Exclude<BrainSchema.Format, "pdf" | "docx" | "pptx" | "xlsx" | "openapi">

const TEXT_FORMATS: Record<string, TextFormat | undefined> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  xhtml: "html",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  csv: "csv",
  tsv: "csv",
  txt: "text",
  text: "text",
  rst: "text",
  adoc: "text",
  asciidoc: "text",
}

const MIME_FORMATS: Record<string, TextFormat | undefined> = {
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/html": "html",
  "application/json": "json",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "application/x-yaml": "yaml",
  "text/csv": "csv",
  "text/tab-separated-values": "csv",
  "text/plain": "text",
}

const LEGACY: Record<string, string | undefined> = {
  doc: ".docx",
  dot: ".docx",
  ppt: ".pptx",
  pps: ".pptx",
  xls: ".xlsx",
  xlt: ".xlsx",
}

const OFFICE: Record<string, Sniffed["format"] | undefined> = {
  docx: "docx",
  docm: "docx",
  pptx: "pptx",
  pptm: "pptx",
  xlsx: "xlsx",
  xlsm: "xlsx",
}

export const MESSAGES = {
  encrypted: "This file is password protected. Vector doesn't ask for document passwords; add an unprotected copy.",
  image: "Attach images to a message so the model can look at them.",
  archive: "Archives aren't read as documents. Add the documents inside it instead.",
  executable: "Programs aren't documents, so Vector doesn't read them.",
  secret: "This file holds secrets, so Vector doesn't keep it.",
  unsupported:
    "Vector reads PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV, Markdown, HTML, JSON, YAML and text files.",
} as const

export function sniff(input: Input, limits: BrainLimits.Limits): Sniffed | ReadRefusal {
  const name = input.name.replace(/\\/g, "/")
  const base = name.split("/").pop()!
  const extension = base.includes(".") ? base.split(".").pop()!.toLowerCase() : ""
  if (SECRET_FILE.test(name)) return refuse("secret", MESSAGES.secret)
  if (input.bytes.length === 0) return refuse("empty", "This file is empty.")
  const bytes = input.bytes
  const head = ascii(bytes.subarray(0, 1024))
  const largest = Math.max(limits.bytes.pdf, limits.bytes.office, limits.bytes.csv, limits.bytes.text)
  if (bytes.length > largest) return tooLarge(largest)
  // pdf.js accepts a PDF header anywhere in the first kilobyte; text that merely mentions one stays text.
  if (head.startsWith("%PDF-") || (extension === "pdf" && head.includes("%PDF-")))
    return bytes.length > limits.bytes.pdf ? tooLarge(limits.bytes.pdf) : { type: "format", format: "pdf" }
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // Office keeps a password-protected .docx, .pptx or .xlsx in an OLE container with an "EncryptedPackage" stream.
    if (directory(bytes).includes("EncryptedPackage")) return refuse("encrypted", MESSAGES.encrypted)
    return refuse(
      "unsupported",
      `This is an older Office file. Save it as ${LEGACY[extension] ?? ".docx, .pptx or .xlsx"} and add that.`,
    )
  }
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    if (bytes.length > limits.bytes.office) return tooLarge(limits.bytes.office)
    const format = BrainOoxml.kind(bytes, limits)
    if (format === "encrypted") return refuse("encrypted", MESSAGES.encrypted)
    if (format === "invalid") return refuse("invalid", "This Office file is damaged or too large to read safely.")
    return format ? { type: "format", format } : refuse("unsupported", MESSAGES.archive)
  }
  const kind = magic(bytes)
  if (kind) return refuse("unsupported", MESSAGES[kind])
  if (LEGACY[extension])
    return refuse("unsupported", `This is an older Office file. Save it as ${LEGACY[extension]} and add that.`)
  if (OFFICE[extension] || extension === "pdf")
    return refuse("invalid", "This file is damaged: its contents don't match its name.")
  const format =
    TEXT_FORMATS[extension] ??
    MIME_FORMATS[input.mime ?? ""] ??
    (extension === "" || /^(?:readme|license|notice)/i.test(base) ? "text" : undefined)
  if (!format) return refuse("unsupported", MESSAGES.unsupported)
  if (binary(bytes)) return refuse("unsupported", MESSAGES.unsupported)
  const cap = format === "csv" ? limits.bytes.csv : limits.bytes.text
  if (bytes.length > cap) return tooLarge(cap)
  return format === "csv"
    ? { type: "format", format, delimiter: extension === "tsv" ? "\t" : undefined }
    : { type: "format", format }
}

/** Text from a file's bytes: UTF-8 unless a byte order mark says UTF-16. Invalid sequences become U+FFFD. */
export function decode(bytes: Uint8Array) {
  if (starts(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(bytes.subarray(2))
  if (starts(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(bytes.subarray(2))
  return new TextDecoder("utf-8").decode(starts(bytes, [0xef, 0xbb, 0xbf]) ? bytes.subarray(3) : bytes)
}

function tooLarge(cap: number) {
  return refuse(
    "too-large",
    `This file is over ${Math.round(cap / 1024 / 1024)} MB, the most Vector reads for this kind of file.`,
  )
}

function starts(bytes: Uint8Array, prefix: readonly number[]) {
  return prefix.every((byte, index) => bytes[index] === byte)
}

function ascii(bytes: Uint8Array) {
  return String.fromCharCode(...bytes)
}

// The stream names of an OLE container, which are UTF-16: its first directory sector (where the header says it is)
// and the start of the file, where a small container keeps it.
function directory(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = bytes.length >= 0x34 ? 2 ** view.getUint16(0x1e, true) : 512
  const sector = bytes.length >= 0x34 ? view.getUint32(0x30, true) : 0
  const at = (sector + 1) * size
  const decoder = new TextDecoder("utf-16le")
  return `${at < bytes.length && size <= 4096 ? decoder.decode(bytes.subarray(at, at + size)) : ""}${decoder.decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)))}`
}

function magic(bytes: Uint8Array): "image" | "archive" | "executable" | undefined {
  const head = ascii(bytes.subarray(0, 16))
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47]) || starts(bytes, [0xff, 0xd8, 0xff]) || head.startsWith("GIF8"))
    return "image"
  if (head.startsWith("BM") && bytes.length > 26 && bytes[14]! >= 12 && bytes[15] === 0) return "image"
  if ((head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") || /^....ftyp(?:heic|heix|avif|mif1)/s.test(head))
    return "image"
  if (starts(bytes, [0x49, 0x49, 0x2a, 0x00]) || starts(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image"
  if (starts(bytes, [0x1f, 0x8b]) || starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || head.startsWith("Rar!"))
    return "archive"
  if (
    starts(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
    head.startsWith("BZh") ||
    starts(bytes, [0x28, 0xb5, 0x2f, 0xfd])
  )
    return "archive"
  if (bytes.length > 262 && ascii(bytes.subarray(257, 262)) === "ustar") return "archive"
  if (head.startsWith("\x7fELF") || head.startsWith("MZ")) return "executable"
  if (
    [
      [0xfe, 0xed, 0xfa, 0xce],
      [0xfe, 0xed, 0xfa, 0xcf],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xce, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
    ].some((prefix) => starts(bytes, prefix))
  )
    return "executable"
  if (head.startsWith("\0asm")) return "executable"
  return undefined
}

// A NUL byte in the first 8 KB is a binary file, unless a byte order mark says the text is UTF-16.
function binary(bytes: Uint8Array) {
  if (starts(bytes, [0xff, 0xfe]) || starts(bytes, [0xfe, 0xff])) return false
  return bytes.subarray(0, 8192).includes(0)
}
