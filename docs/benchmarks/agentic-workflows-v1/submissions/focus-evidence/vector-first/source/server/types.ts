export type DocumentInput = { source: string; title: string; body: string }
export type DocumentRow = DocumentInput & { id: number; created_at: string; version: number }
export type Operation = ({ type: "upsert" } & DocumentInput) | { type: "delete"; source: string }
export type Batch = { batchId: string; operations: Operation[] }
export type OperationResult = { type: Operation["type"]; source: string; documentId: number | null; version: number | null; changed: boolean }
export type Receipt = { batchId: string; revision: number; replayed: boolean; operations: OperationResult[] }
export type Citation = { documentId: number; version: number; startByte: number; endByte: number; quote: string }
export type SearchResult = Pick<DocumentRow, "id" | "source" | "title" | "version"> & { snippet: string; citation: Citation }

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object.")
  return value as Record<string, unknown>
}

function scalarText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be text.`)
  for (const scalar of value) {
    const code = scalar.codePointAt(0)!
    if (code >= 0xd800 && code <= 0xdfff) throw new Error(`${name} contains an unpaired surrogate.`)
  }
  return value
}

function shortText(value: unknown, name: string): string {
  const text = scalarText(value, name)
  if (!text.trim() || [...text].length > 200) throw new Error(`${name} must contain 1 to 200 Unicode scalar values and not be blank.`)
  return text
}

function sourceInput(value: unknown) {
  const source = shortText(value, "Source")
  if (/[\u0000-\u001f]/.test(source)) throw new Error("Source must not contain control characters.")
  return source
}

export function documentInput(value: unknown): DocumentInput {
  const row = object(value)
  const source = sourceInput(row.source)
  const title = shortText(row.title, "Title")
  const body = scalarText(row.body, "Body")
  if (body.includes("\0") || Buffer.byteLength(body, "utf8") > 1_048_576) throw new Error("Body must have no NUL and at most 1,048,576 UTF-8 bytes.")
  return { source, title, body }
}

export function batchInput(value: unknown[]): Batch {
  const header = object(value[0])
  if (header.type !== "batch" || typeof header.batchId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(header.batchId)) throw new Error("First nonblank line must be a batch header with a valid batchId.")
  if (value.length < 2 || value.length > 129) throw new Error("A batch must contain 1 to 128 operations.")
  const seen = new Set<string>()
  const operations = value.slice(1).map((input): Operation => {
    const row = object(input)
    let operation: Operation
    if (row.type === "upsert") operation = { type: "upsert", ...documentInput(row) }
    else if (row.type === "delete") operation = { type: "delete", source: sourceInput(row.source) }
    else throw new Error("Each operation must be an upsert or delete; extra batch headers are not allowed.")
    if (seen.has(operation.source)) throw new Error(`Duplicate source: ${operation.source}`)
    seen.add(operation.source)
    return operation
  })
  return { batchId: header.batchId, operations }
}

export function terms(query: string) {
  return [...new Set((query.match(/[A-Za-z0-9]+/g) ?? []).map((token) => token.toLowerCase()))]
}
