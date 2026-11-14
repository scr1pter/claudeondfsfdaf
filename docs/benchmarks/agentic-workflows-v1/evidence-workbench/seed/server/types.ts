export type DocumentInput = { source: string; title: string; body: string }
export type DocumentRow = DocumentInput & { id: number; created_at: string }

export function documentInput(value: unknown): DocumentInput {
  if (typeof value !== "object" || value === null) throw new Error("Expected a document object.")
  const row = value as Record<string, unknown>
  if (typeof row.source !== "string" || !row.source.trim()) throw new Error("Source is required.")
  if (typeof row.title !== "string" || !row.title.trim()) throw new Error("Title is required.")
  if (typeof row.body !== "string") throw new Error("Body must be text.")
  return { source: row.source, title: row.title, body: row.body }
}

export function terms(query: string) {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
}
