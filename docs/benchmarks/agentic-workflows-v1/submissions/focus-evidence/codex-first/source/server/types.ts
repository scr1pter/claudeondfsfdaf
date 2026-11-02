export type DocumentInput = { source: string; title: string; body: string }
export type DocumentRow = DocumentInput & { id: number; created_at: string; version: number }
export type Operation = ({ type: "upsert" } & DocumentInput) | { type: "delete"; source: string }
export type Batch = { batchId: string; operations: Operation[] }
export type OperationReceipt = { type: Operation["type"]; source: string; documentId: number | null; version: number | null; changed: boolean }
export type BatchReceipt = { batchId: string; revision: number; replayed: boolean; operations: OperationReceipt[] }
export type Citation = { documentId: number; version: number; startByte: number; endByte: number; quote: string }
export type SearchResult = { id: number; source: string; title: string; version: number; snippet: string; citation: Citation }

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object.")
  return value as Record<string, unknown>
}

function scalarLength(value: string): number {
  let count = 0
  for (let i = 0; i < value.length; i++, count++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Text must not contain unpaired surrogates.")
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("Text must not contain unpaired surrogates.")
  }
  return count
}

function sourceInput(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Source must be a nonblank string.")
  if (scalarLength(value) > 200 || /[\u0000-\u001f]/.test(value)) throw new Error("Source must have at most 200 Unicode characters and no control characters.")
  return value
}

export function documentInput(value: unknown): DocumentInput {
  const row = object(value)
  const source = sourceInput(row.source)
  if (typeof row.title !== "string" || !row.title.trim()) throw new Error("Title must be a nonblank string.")
  if (scalarLength(row.title) > 200) throw new Error("Title must have at most 200 Unicode characters.")
  if (typeof row.body !== "string") throw new Error("Body must be text.")
  scalarLength(row.body)
  if (row.body.includes("\0") || Buffer.byteLength(row.body, "utf8") > 1_048_576) throw new Error("Body must have no NUL characters and at most 1,048,576 UTF-8 bytes.")
  return { source, title: row.title, body: row.body }
}

export function parseBatch(text: string): Batch {
  try {
    const lines = text.split(/\r?\n/).filter((line) => line.trim())
    if (lines.length < 2 || lines.length > 129) throw new Error("Provide one batch header followed by 1–128 operations.")
    const header = object(JSON.parse(lines[0]))
    if (header.type !== "batch" || typeof header.batchId !== "string" || header.batchId.length < 1 || header.batchId.length > 80 || /[^A-Za-z0-9_-]/.test(header.batchId)) throw new Error("The first line must be a batch header with a valid batchId (1–80 letters, digits, underscores or hyphens).")
    const sources = new Set<string>()
    const operations = lines.slice(1).map((line): Operation => {
      const value = object(JSON.parse(line))
      let operation: Operation
      if (value.type === "upsert") operation = { type: "upsert", ...documentInput(value) }
      else if (value.type === "delete") operation = { type: "delete", source: sourceInput(value.source) }
      else throw new Error("Each operation must have type upsert or delete; extra batch headers are not allowed.")
      if (sources.has(operation.source)) throw new Error("A source may appear only once in a batch.")
      sources.add(operation.source)
      return operation
    })
    return { batchId: header.batchId, operations }
  } catch (error) {
    throw new ApiError("invalid_batch", error instanceof SyntaxError ? "Invalid JSON in batch NDJSON." : error instanceof Error ? error.message : "Invalid batch.")
  }
}

export function parseImport(text: string, ndjson: boolean): DocumentInput[] {
  try {
    const values: unknown[] = ndjson ? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)) : [JSON.parse(text)]
    if (!values.length) throw new Error("Provide at least one document.")
    return values.map(documentInput)
  } catch (error) {
    throw new ApiError("invalid_document", error instanceof SyntaxError ? "Invalid JSON in document import." : error instanceof Error ? error.message : "Invalid document.")
  }
}

export function terms(query: string): string[] {
  return [...new Set((query.match(/[A-Za-z0-9]+/g) ?? []).map((term) => term.toLowerCase()))]
}

export function queryTerms(query: string): string[] {
  const tokens = terms(query)
  if (!tokens.length || tokens.length > 8) throw new ApiError("invalid_query", "Search requires 1–8 distinct ASCII words or numbers.")
  return tokens
}

export function integerParameter(value: string | null, positive = false, code = "invalid_range"): number {
  if (value === null || !value.length || /[^0-9]/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (positive ? 1 : 0)) throw new ApiError(code, "Parameters must be valid " + (positive ? "positive" : "nonnegative") + " integers.")
  return Number(value)
}
