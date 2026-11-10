import { Database, type Statement } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { ApiError, batchInput, documentInput, terms } from "./types"
import type { Citation, DocumentInput, DocumentRow, Operation, OperationResult, Receipt } from "./types"

const columns = "id,source,title,body,created_at,version"
type Stored = DocumentRow & { active: number }

export function openStore(directory: string) {
  mkdirSync(directory, { recursive: true })
  const db = new Database(join(directory, "workbench.sqlite"), { create: true })
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON")

  // Keep ownership of statements so closing the store releases every SQLite handle.
  const statements = new Map<string, Statement>()
  function query(sql: string) {
    let statement = statements.get(sql)
    if (!statement) { statement = db.prepare(sql); statements.set(sql, statement) }
    return statement
  }

  function index(row: DocumentRow) {
    query("DELETE FROM document_tokens WHERE document_id = ?").run(row.id)
    const insert = query("INSERT INTO document_tokens (document_id, token) VALUES (?, ?)")
    terms(row.title + " " + row.body).forEach(token => insert.run(row.id, token))
  }

  db.transaction(() => {
    const schema = query("PRAGMA user_version").get() as { user_version: number }
    if (schema.user_version > 2) throw new Error("Unsupported database schema.")
    if (schema.user_version === 2) return
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
    INSERT INTO document_versions SELECT id,1,title,body,created_at FROM documents;
    CREATE TABLE collection (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL, cursor_key TEXT NOT NULL);
    CREATE TABLE batch_receipts (batch_id TEXT PRIMARY KEY, identity TEXT NOT NULL, receipt TEXT NOT NULL);`)
    const rows = query(`SELECT ${columns} FROM documents`).all() as DocumentRow[]
    query("INSERT INTO collection VALUES (1, ?, ?)").run(rows.length ? 1 : 0, randomBytes(32).toString("hex"))
    db.exec("DELETE FROM document_tokens")
    rows.forEach(index)
    db.exec("PRAGMA user_version = 2")
  }).immediate()

  const cursorKey = (query("SELECT cursor_key FROM collection WHERE singleton = 1").get() as { cursor_key: string }).cursor_key
  function revision() { return (query("SELECT revision FROM collection WHERE singleton = 1").get() as { revision: number }).revision }
  function get(id: number) { return query(`SELECT ${columns} FROM documents WHERE id = ? AND active = 1`).get(id) as DocumentRow | null }
  function historical(id: number, version: number) {
    return query(`SELECT d.id,d.source,v.title,v.body,v.created_at,v.version FROM documents d
      JOIN document_versions v ON d.id = v.document_id WHERE d.id = ? AND v.version = ?`).get(id, version) as DocumentRow | null
  }
  function versions(id: number) {
    if (!query("SELECT id FROM documents WHERE id = ?").get(id)) throw new ApiError("not_found", "Document not found.", 404)
    return query("SELECT version,title,created_at FROM document_versions WHERE document_id = ? ORDER BY version").all(id) as Pick<DocumentRow, "version" | "title" | "created_at">[]
  }
  function apply(operation: Operation): OperationResult {
    const previous = query("SELECT * FROM documents WHERE source = ?").get(operation.source) as Stored | null
    if (operation.type === "delete") {
      const changed = previous?.active === 1
      if (changed) {
        query("UPDATE documents SET active = 0 WHERE id = ?").run(previous.id)
        query("DELETE FROM document_tokens WHERE document_id = ?").run(previous.id)
      }
      return { type: "delete", source: operation.source, documentId: previous?.id ?? null, version: null, changed }
    }
    if (previous?.active === 1 && previous.title === operation.title && previous.body === operation.body) {
      return { type: "upsert", source: operation.source, documentId: previous.id, version: previous.version, changed: false }
    }
    const version = previous ? previous.version + 1 : 1
    const timestamp = new Date().toISOString()
    if (previous) {
      query("UPDATE documents SET title = ?, body = ?, created_at = ?, version = ?, active = 1 WHERE id = ?")
        .run(operation.title, operation.body, timestamp, version, previous.id)
    } else {
      query("INSERT INTO documents (source,title,body,created_at,version,active) VALUES (?,?,?,?,1,1)")
        .run(operation.source, operation.title, operation.body, timestamp)
    }
    const row = query(`SELECT ${columns} FROM documents WHERE source = ?`).get(operation.source) as DocumentRow
    query("INSERT INTO document_versions (document_id,version,title,body,created_at) VALUES (?,?,?,?,?)")
      .run(row.id, version, row.title, row.body, timestamp)
    index(row)
    return { type: "upsert", source: row.source, documentId: row.id, version, changed: true }
  }
  function advance(changed: boolean) {
    if (changed) query("UPDATE collection SET revision = revision + 1 WHERE singleton = 1").run()
    return revision()
  }
  function importMany(values: unknown[]) {
    let inputs: DocumentInput[]
    try {
      if (!values.length) throw new Error("At least one document is required.")
      inputs = values.map(documentInput)
    } catch (error) { throw new ApiError("invalid_document", error instanceof Error ? error.message : "Invalid document.") }
    return db.transaction(() => {
      let changed = false
      const documents = inputs.map(input => {
        const result = apply({ type: "upsert", ...input })
        changed ||= result.changed
        return get(result.documentId!)!
      })
      advance(changed)
      return documents
    }).immediate()
  }
  function batch(text: string): Receipt {
    const input = batchInput(text)
    const identity = JSON.stringify(input.operations)
    return db.transaction(() => {
      const stored = query("SELECT identity,receipt FROM batch_receipts WHERE batch_id = ?").get(input.batchId) as { identity: string; receipt: string } | null
      if (stored) {
        if (stored.identity !== identity) throw new ApiError("batch_conflict", "This batch ID was already used for different operations.", 409)
        return { ...JSON.parse(stored.receipt), replayed: true } as Receipt
      }
      const operations = input.operations.map(apply)
      const receipt: Receipt = { batchId: input.batchId, revision: advance(operations.some(op => op.changed)), replayed: false, operations }
      query("INSERT INTO batch_receipts VALUES (?,?,?)").run(input.batchId, identity, JSON.stringify(receipt))
      return receipt
    }).immediate()
  }

  function citation(documentId: number, version: number, startByte: number, endByte: number): Citation {
    if (![documentId, version].every(n => Number.isSafeInteger(n) && n > 0) || ![startByte, endByte].every(n => Number.isSafeInteger(n) && n >= 0) || startByte > endByte) {
      throw new ApiError("invalid_range", "Supply positive IDs and ordered nonnegative byte offsets.")
    }
    const row = historical(documentId, version)
    if (!row) throw new ApiError("not_found", "Document version not found.", 404)
    const bytes = Buffer.from(row.body, "utf8")
    const boundary = (n: number) => n <= bytes.length && (n === bytes.length || (bytes[n] & 0xc0) !== 0x80)
    if (!boundary(startByte) || !boundary(endByte)) throw new ApiError("invalid_range", "Byte offsets must be within the body and on Unicode scalar boundaries.")
    return { documentId, version, startByte, endByte, quote: bytes.subarray(startByte, endByte).toString("utf8") }
  }
  function excerpt(row: DocumentRow, tokens: string[]): Citation {
    let start = 0
    let firstMatch: number | undefined
    for (const match of row.body.matchAll(/[A-Za-z0-9]+/g)) {
      if (tokens.includes(match[0].toLowerCase())) {
        firstMatch ??= match.index
        start = firstMatch
        // Prefer a complete matching token that fits the excerpt byte budget.
        if (match[0].length <= 512) { start = match.index; break }
      }
    }
    const startByte = Buffer.byteLength(row.body.slice(0, start), "utf8")
    const bytes = Buffer.from(row.body, "utf8")
    let endByte = Math.min(bytes.length, startByte + 512)
    while (endByte < bytes.length && (bytes[endByte] & 0xc0) === 0x80) endByte--
    return { documentId: row.id, version: row.version, startByte, endByte, quote: bytes.subarray(startByte, endByte).toString("utf8") }
  }
  function matches(tokens: string[], after = 0, count = -1) {
    return query(`SELECT ${columns.split(",").map(c => `d.${c}`).join(",")} FROM documents d
      JOIN document_tokens t ON d.id = t.document_id
      WHERE d.active = 1 AND d.id > ? AND t.token IN (${tokens.map(() => "?").join(",")})
      GROUP BY d.id HAVING COUNT(DISTINCT t.token) = ? ORDER BY d.id LIMIT ?`).all(after, ...tokens, tokens.length, count) as DocumentRow[]
  }
  function queryTerms(query: string) {
    const tokens = terms(query)
    if (tokens.length < 1 || tokens.length > 8) throw new ApiError("invalid_query", "Search requires 1–8 distinct ASCII words or numbers.")
    return tokens
  }
  const sign = (payload: string) => createHmac("sha256", cursorKey).update(payload).digest("base64url")
  function searchPage(query: string, limit: number, cursor: string | null = null) {
    const tokens = queryTerms(query)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError("invalid_limit", "Limit must be an integer from 1 to 50.")
    return db.transaction(() => {
      const currentRevision = revision()
      let after = 0
      if (cursor !== null) {
        let decoded: { query: string; limit: number; revision: number; after: number }
        try {
          const [payload, signature, extra] = cursor.split(".")
          if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error()
          const expected = Buffer.from(sign(payload))
          const actual = Buffer.from(signature)
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error()
          decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
          if (decoded.query !== query || decoded.limit !== limit || !Number.isSafeInteger(decoded.revision) || decoded.revision < 0 || !Number.isSafeInteger(decoded.after) || decoded.after < 1) throw new Error()
        } catch { throw new ApiError("invalid_cursor", "Cursor is malformed or belongs to another query or page size.") }
        if (decoded.revision !== currentRevision) throw new ApiError("stale_cursor", "Collection changed. Restart the search.", 409)
        after = decoded.after
      }
      const rows = matches(tokens, after, limit + 1)
      const results = rows.slice(0, limit).map(row => {
        const citation = excerpt(row, tokens)
        return { id: row.id, source: row.source, title: row.title, version: row.version, snippet: citation.quote, citation }
      })
      let nextCursor: string | null = null
      if (rows.length > limit) {
        const payload = Buffer.from(JSON.stringify({ query, limit, revision: currentRevision, after: results.at(-1)!.id })).toString("base64url")
        nextCursor = `${payload}.${sign(payload)}`
      }
      return { query, revision: currentRevision, results, nextCursor }
    })()
  }

  return {
    revision, batch, importMany, get, historical, versions, citation, searchPage,
    import(value: unknown) { return importMany([value])[0] },
    list() { return query(`SELECT ${columns} FROM documents WHERE active = 1 ORDER BY id`).all() as DocumentRow[] },
    collection() { return db.transaction(() => ({ documents: query(`SELECT ${columns} FROM documents WHERE active = 1 ORDER BY id`).all() as DocumentRow[], revision: revision() }))() },
    search(query: string) { return matches(queryTerms(query)).map(row => ({ ...row, snippet: excerpt(row, terms(query)).quote })) },
    close() { for (const statement of statements.values()) statement.finalize(); statements.clear(); db.close(true) },
  }
}

