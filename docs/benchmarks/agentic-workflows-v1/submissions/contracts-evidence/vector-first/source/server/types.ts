export type DocumentInput = { source: string; title: string; body: string }
export type DocumentRow = DocumentInput & { id: number; created_at: string; version: number }
export type Operation = ({ type: "upsert" } & DocumentInput) | { type: "delete"; source: string }
export type Batch = { batchId: string; operations: Operation[] }
export type OperationReceipt = { type: Operation["type"]; source: string; documentId: number | null; version: number | null; changed: boolean }
export type BatchReceipt = { batchId: string; revision: number; replayed: boolean; operations: OperationReceipt[] }
export type Citation = { documentId: number; version: number; startByte: number; endByte: number; quote: string }
export type SearchResult = Pick<DocumentRow, "id" | "source" | "title" | "version"> & { snippet: string; citation: Citation }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validText(value: unknown, maxScalars?: number): value is string {
  if (typeof value !== "string") return false
  let length = 0
  for (const scalar of value) {
    const code = scalar.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) return false
    if (maxScalars !== undefined && ++length > maxScalars) return false
  }
  return true
}

export function sourceInput(value: unknown, code = "invalid_document"): string {
  if (!validText(value, 200) || !value.trim() || /[\u0000-\u001f]/.test(value)) {
    throw new ApiError(400, code, "Source must be nonblank text of at most 200 Unicode scalars, without control characters.")
  }
  return value
}

export function documentInput(value: unknown, code = "invalid_document"): DocumentInput {
  if (!object(value)) throw new ApiError(400, code, "Expected a document object.")
  const row = value as Record<string, unknown>
  const source = sourceInput(row.source, code)
  if (!validText(row.title, 200) || !row.title.trim()) throw new ApiError(400, code, "Title must be nonblank text of at most 200 Unicode scalars.")
  if (!validText(row.body) || row.body.includes("\0") || Buffer.byteLength(row.body, "utf8") > 1_048_576) {
    throw new ApiError(400, code, "Body must be valid Unicode text without NUL, at most 1,048,576 UTF-8 bytes.")
  }
  return { source, title: row.title, body: row.body }
}

export function parseJson(text: string, code: string): unknown {
  try { return JSON.parse(text) } catch { throw new ApiError(400, code, "Invalid JSON. Check each input line.") }
}

export function batchInput(text: string): Batch {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2 || lines.length > 129) throw new ApiError(400, "invalid_batch", "A batch requires one header and 1-128 operations.")
  const header = parseJson(lines[0], "invalid_batch")
  if (!object(header) || header.type !== "batch" || typeof header.batchId !== "string" || header.batchId.length < 1 || header.batchId.length > 80 || /[^A-Za-z0-9_-]/.test(header.batchId)) {
    throw new ApiError(400, "invalid_batch", "The first line must be a batch header with a valid batchId (1-80 letters, digits, underscores or hyphens).")
  }
  const seen = new Set<string>()
  const operations = lines.slice(1).map((line): Operation => {
    const value = parseJson(line, "invalid_batch")
    if (!object(value) || (value.type !== "upsert" && value.type !== "delete")) throw new ApiError(400, "invalid_batch", "Each operation must have type upsert or delete; only one header is allowed.")
    const source = sourceInput(value.source, "invalid_batch")
    if (seen.has(source)) throw new ApiError(400, "invalid_batch", `Duplicate source in batch: ${source}`)
    seen.add(source)
    return value.type === "delete" ? { type: "delete", source } : { type: "upsert", ...documentInput(value, "invalid_batch") }
  })
  return { batchId: header.batchId, operations }
}

export function terms(query: string) {
  return [...new Set((query.match(/[A-Za-z0-9]+/g) ?? []).map((token) => token.toLowerCase()))]
}
