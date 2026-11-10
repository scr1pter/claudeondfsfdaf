import { Database } from "bun:sqlite"
import { createHmac, randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ApiError, batchInput, documentInput, terms } from "./types"
import type { BatchReceipt, Citation, DocumentInput, DocumentRow, Operation, OperationReceipt, SearchResult } from "./types"

const columns = "id, source, title, body, created_at, version"
type StoredDocument = DocumentRow & { active: number }

export function openStore(directory: string) {
  mkdirSync(directory, { recursive: true })
  const db = new Database(join(directory, "workbench.sqlite"), { create: true })
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON")

  function index(row: DocumentRow) {
    db.query("DELETE FROM document_tokens WHERE document_id = ?").run(row.id)
    const insert = db.query("INSERT INTO document_tokens (document_id, token) VALUES (?, ?)")
    terms(row.title + " " + row.body).forEach((token) => insert.run(row.id, token))
  }

  try {
    db.transaction(() => {
      const schema = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
      if (schema > 2) throw new Error("Unsupported database schema version.")
      if (schema === 2) return
      db.exec(`CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE documents ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE document_versions (
        document_id INTEGER NOT NULL REFERENCES documents(id), version INTEGER NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (document_id, version)
      );
      INSERT INTO document_versions SELECT id, 1, title, body, created_at FROM documents;
      CREATE TABLE collection_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL,
        cursor_key TEXT NOT NULL
      );
      CREATE TABLE batch_receipts (batch_id TEXT PRIMARY KEY, identity TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_tokens (
        document_id INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (document_id, token)
      );
      CREATE INDEX IF NOT EXISTS document_tokens_lookup ON document_tokens (token, document_id);
      DELETE FROM document_tokens;`)
      const rows = db.query(`SELECT ${columns} FROM documents ORDER BY id`).all() as DocumentRow[]
      db.query("INSERT INTO collection_state VALUES (1, ?, ?)").run(rows.length ? 1 : 0, randomBytes(32).toString("hex"))
      rows.forEach(index)
      db.exec("PRAGMA user_version = 2")
    }).immediate()
  } catch (error) {
    db.close()
    throw error
  }

  const key = (db.query("SELECT cursor_key FROM collection_state WHERE singleton = 1").get() as { cursor_key: string }).cursor_key
  const revision = () => (db.query("SELECT revision FROM collection_state WHERE singleton = 1").get() as { revision: number }).revision
  const get = (id: number) => db.query(`SELECT ${columns} FROM documents WHERE id = ? AND active = 1`).get(id) as DocumentRow | null
  const historical = (id: number, version: number) => db.query(`SELECT d.id, d.source, v.title, v.body, v.created_at, v.version
    FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.id = ? AND v.version = ?`).get(id, version) as DocumentRow | null

  function apply(operation: Operation): { receipt: OperationReceipt; document?: DocumentRow } {
    const previous = db.query("SELECT * FROM documents WHERE source = ?").get(operation.source) as StoredDocument | null
    if (operation.type === "delete") {
      const changed = previous?.active === 1
      if (changed) {
        db.query("UPDATE documents SET active = 0 WHERE id = ?").run(previous.id)
        db.query("DELETE FROM document_tokens WHERE document_id = ?").run(previous.id)
      }
      return { receipt: { type: "delete", source: operation.source, documentId: previous?.id ?? null, version: null, changed } }
    }
    const changed = !previous || previous.active !== 1 || previous.title !== operation.title || previous.body !== operation.body
    if (changed) {
      const version = (previous?.version ?? 0) + 1
      const created = new Date().toISOString()
      if (previous) {
        db.query("UPDATE documents SET title = ?, body = ?, created_at = ?, version = ?, active = 1 WHERE id = ?")
          .run(operation.title, operation.body, created, version, previous.id)
      } else {
        db.query("INSERT INTO documents (source, title, body, created_at, version, active) VALUES (?, ?, ?, ?, 1, 1)")
          .run(operation.source, operation.title, operation.body, created)
      }
      const row = db.query(`SELECT ${columns} FROM documents WHERE source = ?`).get(operation.source) as DocumentRow
      db.query("INSERT INTO document_versions (document_id, version, title, body, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(row.id, row.version, row.title, row.body, row.created_at)
      index(row)
    }
    const row = db.query(`SELECT ${columns} FROM documents WHERE source = ?`).get(operation.source) as DocumentRow
    return { document: row, receipt: { type: "upsert", source: row.source, documentId: row.id, version: row.version, changed } }
  }

  const commitImport = db.transaction((inputs: DocumentInput[]) => {
    const results = inputs.map((input) => apply({ type: "upsert", ...input }))
    if (results.some((result) => result.receipt.changed)) db.exec("UPDATE collection_state SET revision = revision + 1 WHERE singleton = 1")
    return results.map((result) => result.document!)
  })

  const commitBatch = db.transaction((batch: ReturnType<typeof batchInput>): BatchReceipt => {
    const identity = JSON.stringify(batch.operations)
    const previous = db.query("SELECT identity, receipt FROM batch_receipts WHERE batch_id = ?").get(batch.batchId) as { identity: string; receipt: string } | null
    if (previous) {
      if (previous.identity !== identity) throw new ApiError(409, "batch_conflict", "This batch ID is already reserved for different operations.")
      return { ...JSON.parse(previous.receipt), replayed: true }
    }
    const operations = batch.operations.map((operation) => apply(operation).receipt)
    if (operations.some((operation) => operation.changed)) db.exec("UPDATE collection_state SET revision = revision + 1 WHERE singleton = 1")
    const receipt: BatchReceipt = { batchId: batch.batchId, revision: revision(), replayed: false, operations }
    db.query("INSERT INTO batch_receipts VALUES (?, ?, ?)").run(batch.batchId, identity, JSON.stringify(receipt))
    return receipt
  })

  function citation(id: number, version: number, startByte: number, endByte: number): Citation {
    if (![id, version].every((n) => Number.isSafeInteger(n) && n > 0) || ![startByte, endByte].every((n) => Number.isSafeInteger(n) && n >= 0) || endByte < startByte) {
      throw new ApiError(400, "invalid_range", "Use positive document/version numbers and ordered nonnegative byte offsets.")
    }
    const row = historical(id, version)
    if (!row) throw new ApiError(404, "not_found", "Document version not found.")
    const bytes = Buffer.from(row.body, "utf8")
    const boundary = (offset: number) => offset <= bytes.length && (offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80)
    if (!boundary(startByte) || !boundary(endByte)) throw new ApiError(400, "invalid_range", "Offsets must be within the body on UTF-8 scalar boundaries.")
    return { documentId: id, version, startByte, endByte, quote: bytes.subarray(startByte, endByte).toString("utf8") }
  }

  function search(query: string, after = 0, limit?: number): SearchResult[] {
    const tokens = terms(query)
    if (!tokens.length || tokens.length > 8) throw new ApiError(400, "invalid_query", "Search requires 1-8 distinct ASCII letter/number tokens.")
    const rows = db.query(`SELECT ${columns.split(", ").map((column) => `d.${column}`).join(", ")} FROM documents d
      JOIN document_tokens t ON d.id = t.document_id
      WHERE d.active = 1 AND d.id > ? AND t.token IN (${tokens.map(() => "?").join(",")})
      GROUP BY d.id HAVING COUNT(DISTINCT t.token) = ? ORDER BY d.id LIMIT ?`)
      .all(after, ...tokens, tokens.length, limit ?? -1) as DocumentRow[]
    return rows.map((row) => {
      // ASCII runs have UTF-16 indices; convert the chosen start to a UTF-8 offset.
      let startByte = 0
      for (const match of row.body.matchAll(/[A-Za-z0-9]+/g)) {
        if (match[0].length <= 512 && tokens.includes(match[0].toLowerCase())) {
          startByte = Buffer.byteLength(row.body.slice(0, match.index), "utf8")
          break
        }
      }
      const bytes = Buffer.from(row.body, "utf8")
      let endByte = Math.min(startByte + 512, bytes.length)
      while (endByte < bytes.length && (bytes[endByte] & 0xc0) === 0x80) endByte--
      const quote = bytes.subarray(startByte, endByte).toString("utf8")
      return { id: row.id, source: row.source, title: row.title, version: row.version, snippet: quote,
        citation: { documentId: row.id, version: row.version, startByte, endByte, quote } }
    })
  }

  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url")
  function searchPage(query: string, limit = 10, cursor?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, "invalid_limit", "Limit must be an integer from 1 to 50.")
    const tokens = terms(query)
    if (!tokens.length || tokens.length > 8) throw new ApiError(400, "invalid_query", "Search requires 1-8 distinct ASCII letter/number tokens.")
    // Keep revision and hits in a single read snapshot if another process writes.
    return db.transaction(() => {
      const currentRevision = revision()
      let after = 0
      if (cursor !== undefined) {
        const invalid = () => new ApiError(400, "invalid_cursor", "Cursor is invalid or does not match this query and limit.")
        const parts = cursor.split(".")
        if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || sign(parts[0]) !== parts[1]) throw invalid()
        let value: { query: string; limit: number; revision: number; after: number }
        try { value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) } catch { throw invalid() }
        if (!value || value.query !== query || value.limit !== limit || !Number.isSafeInteger(value.after) || value.after < 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw invalid()
        if (value.revision !== currentRevision) throw new ApiError(409, "stale_cursor", "Collection changed. Restart the search to use the current revision.")
        after = value.after
      }
      const hits = search(query, after, limit + 1)
      const results = hits.slice(0, limit)
      let nextCursor: string | null = null
      if (hits.length > limit) {
        const payload = Buffer.from(JSON.stringify({ query, limit, revision: currentRevision, after: results.at(-1)!.id })).toString("base64url")
        nextCursor = `${payload}.${sign(payload)}`
      }
      return { query, revision: currentRevision, results, nextCursor }
    })()
  }

  return {
    import(value: unknown) { return commitImport.immediate([documentInput(value)])[0] },
    importMany(values: unknown[]) {
      if (!values.length) throw new ApiError(400, "invalid_document", "At least one document is required.")
      const inputs = values.map((value) => documentInput(value))
      return commitImport.immediate(inputs)
    },
    batch(text: string) { return commitBatch.immediate(batchInput(text)) },
    revision,
    list() { return db.query(`SELECT ${columns} FROM documents WHERE active = 1 ORDER BY id`).all() as DocumentRow[] },
    collection() { return db.transaction(() => ({ documents: db.query(`SELECT ${columns} FROM documents WHERE active = 1 ORDER BY id`).all() as DocumentRow[], revision: revision() }))() },
    get,
    historical,
    versions(id: number) {
      if (!db.query("SELECT id FROM documents WHERE id = ?").get(id)) throw new ApiError(404, "not_found", "Document not found.")
      return db.query("SELECT version, title, created_at FROM document_versions WHERE document_id = ? ORDER BY version").all(id) as Pick<DocumentRow, "version" | "title" | "created_at">[]
    },
    citation,
    search,
    searchPage,
    close() { db.close() },
  }
}

export type Store = ReturnType<typeof openStore>
