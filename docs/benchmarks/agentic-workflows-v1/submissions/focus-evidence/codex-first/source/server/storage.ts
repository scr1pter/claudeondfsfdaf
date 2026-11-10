import { Database } from "bun:sqlite"
import { createHmac, randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ApiError, documentInput, parseBatch, queryTerms, terms } from "./types"
import type { BatchReceipt, Citation, DocumentInput, DocumentRow, Operation, OperationReceipt, SearchResult } from "./types"

type StoredDocument = DocumentRow & { active: number }
const fields = "id, source, title, body, created_at, version"

function isBoundary(bytes: Buffer, offset: number): boolean {
  return offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80
}

function citation(row: DocumentRow, startByte: number, endByte: number): Citation {
  const bytes = Buffer.from(row.body, "utf8")
  if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || startByte < 0 || endByte < startByte || endByte > bytes.length || !isBoundary(bytes, startByte) || !isBoundary(bytes, endByte)) {
    throw new ApiError("invalid_range", "Byte offsets must be ordered, within the body, and on Unicode scalar boundaries.")
  }
  return { documentId: row.id, version: row.version, startByte, endByte, quote: bytes.subarray(startByte, endByte).toString("utf8") }
}

function excerpt(row: DocumentRow, tokens: string[]): Citation {
  const bytes = Buffer.from(row.body, "utf8")
  const wanted = new Set(tokens)
  let start = 0
  for (const match of row.body.matchAll(/[A-Za-z0-9]+/g)) {
    if (!wanted.has(match[0].toLowerCase())) continue
    // Prefer a matching token that can fit whole inside the 512-byte excerpt.
    if (match[0].length > 512) continue
    const tokenStart = Buffer.byteLength(row.body.slice(0, match.index), "utf8")
    const tokenEnd = tokenStart + match[0].length
    start = Math.max(0, tokenStart - 128, tokenEnd - 512)
    while (start < bytes.length && !isBoundary(bytes, start)) start++
    break
  }
  let end = Math.min(bytes.length, start + 512)
  while (end > start && !isBoundary(bytes, end)) end--
  return citation(row, start, end)
}

export function openStore(directory: string) {
  mkdirSync(directory, { recursive: true })
  const db = new Database(join(directory, "workbench.sqlite"), { create: true })
  // Explicitly finalize prepared statements on close, including statements used
  // on rejected requests. This also releases Windows database file handles.
  const statements = new Map<string, ReturnType<Database["prepare"]>>()
  function query(sql: string) {
    let statement = statements.get(sql)
    if (!statement) { statement = db.prepare(sql); statements.set(sql, statement) }
    return statement
  }
  function close() {
    for (const statement of statements.values()) statement.finalize()
    statements.clear()
    db.close(true)
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000")

  function index(row: DocumentRow) {
    query("DELETE FROM document_tokens WHERE document_id = ?").run(row.id)
    const insert = query("INSERT INTO document_tokens (document_id, token) VALUES (?, ?)")
    terms(row.title + " " + row.body).forEach((token) => insert.run(row.id, token))
  }

  // A single migration transaction preserves v1 IDs and text, and can be safely retried.
  try {
    db.transaction(() => {
      const schema = (query("PRAGMA user_version").get() as { user_version: number }).user_version
      if (schema > 2) throw new Error("Unsupported database schema version.")
      if (schema === 2) return
      db.exec(`CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      ); CREATE TABLE IF NOT EXISTS document_tokens (
        document_id INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (document_id, token)
      ); CREATE INDEX IF NOT EXISTS document_tokens_lookup ON document_tokens (token, document_id);
      ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE documents ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE document_versions (
        document_id INTEGER NOT NULL REFERENCES documents(id), version INTEGER NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (document_id, version)
      );
      INSERT INTO document_versions (document_id, version, title, body, created_at)
        SELECT id, 1, title, body, created_at FROM documents;
      CREATE TABLE collection_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL, cursor_key TEXT NOT NULL);
      CREATE TABLE batch_receipts (batch_id TEXT PRIMARY KEY, identity TEXT NOT NULL, receipt TEXT NOT NULL);`)
      const rows = query(`SELECT ${fields} FROM documents ORDER BY id`).all() as DocumentRow[]
      query("INSERT INTO collection_state VALUES (1, ?, ?)").run(rows.length ? 1 : 0, randomBytes(32).toString("hex"))
      db.exec("DELETE FROM document_tokens")
      rows.forEach(index)
      db.exec("PRAGMA user_version = 2")
    }).immediate()
  } catch (error) { close(); throw error }

  const cursorKey = (query("SELECT cursor_key FROM collection_state WHERE singleton = 1").get() as { cursor_key: string }).cursor_key
  const revision = () => (query("SELECT revision FROM collection_state WHERE singleton = 1").get() as { revision: number }).revision
  const advance = () => query("UPDATE collection_state SET revision = revision + 1 WHERE singleton = 1").run()
  const get = (id: number) => query(`SELECT ${fields} FROM documents WHERE id = ? AND active = 1`).get(id) as DocumentRow | null
  const historical = (id: number, version: number) => query(`SELECT d.id, d.source, v.title, v.body, v.created_at, v.version
    FROM documents d JOIN document_versions v ON d.id = v.document_id WHERE d.id = ? AND v.version = ?`).get(id, version) as DocumentRow | null

  function upsert(input: DocumentInput): { document: DocumentRow; changed: boolean } {
    const prior = query("SELECT * FROM documents WHERE source = ?").get(input.source) as StoredDocument | null
    if (prior?.active && prior.title === input.title && prior.body === input.body) return { document: get(prior.id)!, changed: false }
    const version = (prior?.version ?? 0) + 1
    const created = new Date().toISOString()
    let id: number
    if (prior) {
      id = prior.id
      query("UPDATE documents SET title = ?, body = ?, created_at = ?, version = ?, active = 1 WHERE id = ?").run(input.title, input.body, created, version, id)
    } else {
      id = Number(query("INSERT INTO documents (source, title, body, created_at, version, active) VALUES (?, ?, ?, ?, ?, 1)").run(input.source, input.title, input.body, created, version).lastInsertRowid)
    }
    const document = { id, source: input.source, title: input.title, body: input.body, created_at: created, version }
    query("INSERT INTO document_versions (document_id, version, title, body, created_at) VALUES (?, ?, ?, ?, ?)").run(id, version, input.title, input.body, created)
    index(document)
    return { document, changed: true }
  }

  function apply(operation: Operation): OperationReceipt {
    if (operation.type === "upsert") {
      const { document, changed } = upsert(operation)
      return { type: "upsert", source: operation.source, documentId: document.id, version: document.version, changed }
    }
    const prior = query("SELECT id, active FROM documents WHERE source = ?").get(operation.source) as { id: number; active: number } | null
    if (prior?.active) {
      query("UPDATE documents SET active = 0 WHERE id = ?").run(prior.id)
      query("DELETE FROM document_tokens WHERE document_id = ?").run(prior.id)
    }
    return { type: "delete", source: operation.source, documentId: prior?.id ?? null, version: null, changed: !!prior?.active }
  }

  function matching(tokens: string[], after = 0, limit = -1): SearchResult[] {
    const rows = query(`SELECT ${fields.split(", ").map((field) => "d." + field).join(", ")} FROM documents d
      JOIN document_tokens t ON d.id = t.document_id WHERE d.active = 1 AND d.id > ? AND t.token IN (${tokens.map(() => "?").join(",")})
      GROUP BY d.id HAVING COUNT(DISTINCT t.token) = ? ORDER BY d.id LIMIT ?`).all(after, ...tokens, tokens.length, limit) as DocumentRow[]
    return rows.map((row) => {
      const bound = excerpt(row, tokens)
      return { id: row.id, source: row.source, title: row.title, version: row.version, snippet: bound.quote, citation: bound }
    })
  }

  const sign = (payload: string) => createHmac("sha256", cursorKey).update(payload).digest("base64url")
  function encodeCursor(currentRevision: number, query: string, limit: number, position: number): string {
    const payload = Buffer.from(JSON.stringify({ r: currentRevision, q: query, l: limit, p: position })).toString("base64url")
    return payload + "." + sign(payload)
  }
  function decodeCursor(cursor: string, query: string, limit: number): { r: number; p: number } {
    try {
      const parts = cursor.split(".")
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || parts[1] !== sign(parts[0])) throw new Error()
      const value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))
      if (value.q !== query || value.l !== limit || !Number.isSafeInteger(value.r) || value.r < 0 || !Number.isSafeInteger(value.p) || value.p < 1) throw new Error()
      return value
    } catch { throw new ApiError("invalid_cursor", "Cursor is malformed or does not match the exact query and page size.") }
  }

  return {
    revision,
    import(value: unknown) { return this.importMany([value])[0] },
    importMany(values: unknown[]) {
      const inputs = values.map(documentInput)
      if (!inputs.length) throw new ApiError("invalid_document", "Provide at least one document.")
      return db.transaction(() => {
        let changed = false
        const documents = inputs.map((input) => {
          const result = upsert(input)
          changed ||= result.changed
          return result.document
        })
        if (changed) advance()
        return documents
      }).immediate()
    },
    batch(text: string): BatchReceipt {
      const batch = parseBatch(text)
      // Explicit accepted fields make identity independent of JSON layout and extra keys.
      const identity = JSON.stringify(batch.operations)
      return db.transaction(() => {
        const prior = query("SELECT identity, receipt FROM batch_receipts WHERE batch_id = ?").get(batch.batchId) as { identity: string; receipt: string } | null
        if (prior) {
          if (prior.identity !== identity) throw new ApiError("batch_conflict", "This batch ID is already reserved for different operations.", 409)
          return { ...JSON.parse(prior.receipt), replayed: true } as BatchReceipt
        }
        const operations = batch.operations.map(apply)
        if (operations.some((operation) => operation.changed)) advance()
        const receipt = { batchId: batch.batchId, revision: revision(), replayed: false, operations }
        query("INSERT INTO batch_receipts (batch_id, identity, receipt) VALUES (?, ?, ?)").run(batch.batchId, identity, JSON.stringify(receipt))
        return receipt
      }).immediate()
    },
    list() { return query(`SELECT ${fields} FROM documents WHERE active = 1 ORDER BY id`).all() as DocumentRow[] },
    collection() { return db.transaction(() => ({ documents: this.list(), revision: revision() }))() },
    get,
    historical,
    versions(id: number) {
      if (!query("SELECT id FROM documents WHERE id = ?").get(id)) throw new ApiError("not_found", "Document not found.", 404)
      return query("SELECT version, title, created_at FROM document_versions WHERE document_id = ? ORDER BY version").all(id) as { version: number; title: string; created_at: string }[]
    },
    citation(id: number, version: number, startByte: number, endByte: number) {
      const row = historical(id, version)
      if (!row) throw new ApiError("not_found", "Document version not found.", 404)
      return citation(row, startByte, endByte)
    },
    search(query: string) { return matching(queryTerms(query)) },
    searchPage(query: string, limit: number, cursor: string | null = null) {
      const tokens = queryTerms(query)
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiError("invalid_limit", "Results per page must be an integer from 1 to 50.")
      const continuation = cursor === null ? null : decodeCursor(cursor, query, limit)
      return db.transaction(() => {
        const currentRevision = revision()
        if (continuation && continuation.r !== currentRevision) throw new ApiError("stale_cursor", "Collection changed. Restart the search to use the current revision.", 409)
        const found = matching(tokens, continuation?.p ?? 0, limit + 1)
        const results = found.slice(0, limit)
        return { query, revision: currentRevision, results, nextCursor: found.length > limit ? encodeCursor(currentRevision, query, limit, results[results.length - 1].id) : null }
      })()
    },
    close,
  }
}

