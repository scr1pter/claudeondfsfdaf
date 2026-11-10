export type DocumentInput = { source: string; title: string; body: string }
export type DocumentRow = DocumentInput & { id: number; created_at: string; version: number }
export type Operation = ({ type: "upsert" } & DocumentInput) | { type: "delete"; source: string }
export type Batch = { batchId: string; operations: Operation[] }
export type Citation = { documentId: number; version: number; startByte: number; endByte: number; quote: string }
export type OperationResult = { type: "upsert" | "delete"; source: string; documentId: number | null; version: number | null; changed: boolean }
export type Receipt = { batchId: string; revision: number; replayed: boolean; operations: OperationResult[] }

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}

function validUnicode(text: string) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.")
  return value as Record<string, unknown>
}

function sourceInput(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || !validUnicode(value) || [...value].length > 200 || /[\u0000-\u001f]/.test(value)) {
    throw new Error("Source must be nonblank text of at most 200 Unicode characters, without control characters.")
  }
  return value
}

export function documentInput(value: unknown): DocumentInput {
  const row = object(value)
  const source = sourceInput(row.source)
  if (typeof row.title !== "string" || !row.title.trim() || !validUnicode(row.title) || [...row.title].length > 200) {
    throw new Error("Title must be nonblank text of at most 200 Unicode characters.")
  }
  if (typeof row.body !== "string" || !validUnicode(row.body) || row.body.includes("\0") || Buffer.byteLength(row.body, "utf8") > 1_048_576) {
    throw new Error("Body must be valid Unicode text without NUL, at most 1,048,576 UTF-8 bytes.")
  }
  return { source, title: row.title, body: row.body }
}

export function parseLines(text: string): unknown[] {
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line) } catch { throw new Error(`Invalid JSON on nonblank line ${i + 1}.`) }
  })
}

export function batchInput(text: string): Batch {
  try {
    const [first, ...lines] = parseLines(text)
    const header = object(first)
    if (header.type !== "batch" || typeof header.batchId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(header.batchId)) {
      throw new Error("First nonblank line must be a batch header with a valid batchId.")
    }
    if (lines.length < 1 || lines.length > 128) throw new Error("A batch must contain 1–128 operations.")
    const seen = new Set<string>()
    const operations = lines.map((value): Operation => {
      const row = object(value)
      let operation: Operation
      if (row.type === "upsert") operation = { type: "upsert", ...documentInput(row) }
      else if (row.type === "delete") operation = { type: "delete", source: sourceInput(row.source) }
      else throw new Error("Each operation must have type upsert or delete; extra headers are not allowed.")
      if (seen.has(operation.source)) throw new Error("A source may appear only once in a batch.")
      seen.add(operation.source)
      return operation
    })
    return { batchId: header.batchId, operations }
  } catch (error) {
    throw new ApiError("invalid_batch", error instanceof Error ? error.message : "Invalid batch.")
  }
}

export function terms(query: string) {
  return [...new Set((query.match(/[A-Za-z0-9]+/g) ?? []).map(token => token.toLowerCase()))]
}

export function positiveInteger(value: string | null): number | null {
  if (value === null || !/^[0-9]+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
