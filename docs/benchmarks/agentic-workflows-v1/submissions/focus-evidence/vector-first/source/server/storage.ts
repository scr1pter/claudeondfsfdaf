import { Database } from "bun:sqlite"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ApiError, batchInput, documentInput, terms } from "./types"
import type { Citation, DocumentInput, DocumentRow, Operation, OperationResult, Receipt, SearchResult } from "./types"

type StoredDocument = DocumentRow & { active: number }
const columns = "id, source, title, body, created_at, version"

export function openStore(directory: string) {
  mkdirSync(directory, { recursive: true })
  const db = new Database(join(directory, "workbench.sqlite"), { create: true })
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000")
  // Own statement lifetimes so closing reliably releases Windows file locks.
  const statements = new Map<string, ReturnType<Database["prepare"]>>()
  function sqlQuery(sql: string) {
    let statement = statements.get(sql)
    if (!statement) {
      statement = db.prepare(sql)
      statements.set(sql, statement)
    }
    return statement
  }

  function index(row: DocumentRow) {
    sqlQuery("DELETE FROM document_tokens WHERE document_id = ?").run(row.id)
    const insert = sqlQuery("INSERT INTO document_tokens (document_id, token) VALUES (?, ?)")
    terms(row.title + " " + row.body).forEach((token) => insert.run(row.id, token))
  }

  db.transaction(() => {
    const schema = (sqlQuery("PRAGMA user_version").get() as { user_version: number }).user_version
    if (schema > 2) throw new Error("This database uses a newer schema.")
    if (schema === 2) return
    db.exec(`CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    ); ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE documents ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS document_tokens (
      document_id INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (document_id, token)
    ); CREATE INDEX IF NOT EXISTS document_tokens_lookup ON document_tokens (token, document_id);
    CREATE TABLE document_versions (
      document_id INTEGER NOT NULL REFERENCES documents(id), version INTEGER NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, version)
    ); CREATE TABLE collection (
      id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, cursor_secret TEXT NOT NULL
    ); CREATE TABLE batch_receipts (
      batch_id TEXT PRIMARY KEY, identity TEXT NOT NULL, receipt TEXT NOT NULL
    )`)
    const rows = sqlQuery(`SELECT ${columns} FROM documents ORDER BY id`).all() as DocumentRow[]
    const insert = sqlQuery("INSERT INTO document_versions (document_id, version, title, body, created_at) VALUES (?, 1, ?, ?, ?)")
    db.exec("DELETE FROM document_tokens")
    for (const row of rows) {
      insert.run(row.id, row.title, row.body, row.created_at)
      index(row)
    }
    sqlQuery("INSERT INTO collection VALUES (1, ?, ?)").run(rows.length ? 1 : 0, randomBytes(32).toString("hex"))
    db.exec("PRAGMA user_version = 2")
  }).immediate()

  const secret = (sqlQuery("SELECT cursor_secret FROM collection WHERE id = 1").get() as { cursor_secret: string }).cursor_secret
  const revision = () => (sqlQuery("SELECT revision FROM collection WHERE id = 1").get() as { revision: number }).revision
  const get = (id: number) => sqlQuery(`SELECT ${columns} FROM documents WHERE id = ? AND active = 1`).get(id) as DocumentRow | null
  const historical = (id: number, version: number) => sqlQuery(`SELECT d.id, d.source, v.title, v.body, v.created_at, v.version
    FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.id = ? AND v.version = ?`).get(id, version) as DocumentRow | null

  function apply(operation: Operation): OperationResult {
    const prior = sqlQuery("SELECT * FROM documents WHERE source = ?").get(operation.source) as StoredDocument | null
    if (operation.type === "delete") {
      if (prior?.active) {
        sqlQuery("UPDATE documents SET active = 0 WHERE id = ?").run(prior.id)
        sqlQuery("DELETE FROM document_tokens WHERE document_id = ?").run(prior.id)
      }
      return { type: "delete", source: operation.source, documentId: prior?.id ?? null, version: null, changed: !!prior?.active }
    }
    if (prior?.active && prior.title === operation.title && prior.body === operation.body) {
      return { type: "upsert", source: operation.source, documentId: prior.id, version: prior.version, changed: false }
    }
    const version = (prior?.version ?? 0) + 1
    const createdAt = new Date().toISOString()
    let id: number
    if (prior) {
      id = prior.id
      sqlQuery("UPDATE documents SET title = ?, body = ?, created_at = ?, version = ?, active = 1 WHERE id = ?")
        .run(operation.title, operation.body, createdAt, version, id)
    } else {
      id = Number(sqlQuery("INSERT INTO documents (source, title, body, created_at, version) VALUES (?, ?, ?, ?, ?)")
        .run(operation.source, operation.title, operation.body, createdAt, version).lastInsertRowid)
    }
    sqlQuery("INSERT INTO document_versions (document_id, version, title, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, version, operation.title, operation.body, createdAt)
    index({ ...operation, id, created_at: createdAt, version })
    return { type: "upsert", source: operation.source, documentId: id, version, changed: true }
  }

  function advance(results: OperationResult[]) {
    if (results.some((result) => result.changed)) sqlQuery("UPDATE collection SET revision = revision + 1 WHERE id = 1").run()
    return revision()
  }

  function importMany(values: unknown[]) {
    let inputs: DocumentInput[]
    try {
      if (!values.length) throw new Error("At least one document is required.")
      inputs = values.map(documentInput)
    } catch (error) {
      throw new ApiError("invalid_document", (error as Error).message)
    }
    return db.transaction(() => {
      const results = inputs.map((input) => apply({ type: "upsert", ...input }))
      advance(results)
      return results.map((result) => historical(result.documentId!, result.version!)!)
    }).immediate()
  }

  function batch(values: unknown[]): Receipt {
    let input
    try { input = batchInput(values) }
    catch (error) { throw new ApiError("invalid_batch", (error as Error).message) }
    const identity = JSON.stringify(input.operations)
    return db.transaction(() => {
      const prior = sqlQuery("SELECT identity, receipt FROM batch_receipts WHERE batch_id = ?").get(input.batchId) as { identity: string; receipt: string } | null
      if (prior) {
        if (prior.identity !== identity) throw new ApiError("batch_conflict", "Batch ID already belongs to a different request.", 409)
        return { ...JSON.parse(prior.receipt), replayed: true } as Receipt
      }
      const operations = input.operations.map(apply)
      const receipt: Receipt = { batchId: input.batchId, revision: advance(operations), replayed: false, operations }
      sqlQuery("INSERT INTO batch_receipts VALUES (?, ?, ?)").run(input.batchId, identity, JSON.stringify(receipt))
      return receipt
    }).immediate()
  }

  function citation(documentId: number, version: number, startByte: number, endByte: number): Citation {
    if (![documentId, version].every((n) => Number.isSafeInteger(n) && n > 0) ||
      ![startByte, endByte].every((n) => Number.isSafeInteger(n) && n >= 0) || startByte > endByte) {
      throw new ApiError("invalid_range", "Provide positive document ID/version and ordered nonnegative byte offsets.")
    }
    const row = historical(documentId, version)
    if (!row) throw new ApiError("not_found", "Document version not found.", 404)
    const bytes = Buffer.from(row.body, "utf8")
    const boundary = (offset: number) => offset <= bytes.length && (offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80)
    if (!boundary(startByte) || !boundary(endByte)) throw new ApiError("invalid_range", "Byte offsets must lie within the body on Unicode scalar boundaries.")
    return { documentId, version, startByte, endByte, quote: bytes.subarray(startByte, endByte).toString("utf8") }
  }

  function excerpt(row: DocumentRow, tokens: string[]): Citation {
    let match: RegExpExecArray | undefined
    for (const candidate of row.body.matchAll(/[A-Za-z0-9]+/g)) {
      if (!tokens.includes(candidate[0].toLowerCase())) continue
      match ??= candidate
      if (candidate[0].length <= 512) { match = candidate; break }
    }
    const startByte = match ? Buffer.byteLength(row.body.slice(0, match.index), "utf8") : 0
    const bytes = Buffer.from(row.body, "utf8")
    let endByte = Math.min(startByte + 512, bytes.length)
    while (endByte < bytes.length && (bytes[endByte] & 0xc0) === 0x80) endByte--
    return { documentId: row.id, version: row.version, startByte, endByte, quote: bytes.subarray(startByte, endByte).toString("utf8") }
  }

  const sign = (value: string) => createHmac("sha256", secret).update(value).digest("base64url")
  function cursorFor(query: string, limit: number, currentRevision: number, after: number) {
    const value = Buffer.from(JSON.stringify({ query, limit, revision: currentRevision, after })).toString("base64url")
    return `${value}.${sign(value)}`
  }

  function searchPage(query: string, limit = 10, cursor?: string | null) {
    const tokens = terms(query)
    if (!tokens.length || tokens.length > 8) throw new ApiError("invalid_query", "Search requires 1 to 8 distinct ASCII token terms.")
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiError("invalid_limit", "Limit must be an integer from 1 to 50.")
    return db.transaction(() => {
      const currentRevision = revision()
      let after = 0
      if (cursor !== undefined && cursor !== null) {
        let value: { query: string; limit: number; revision: number; after: number }
        try {
          const parts = cursor.split(".")
          if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error()
          const expected = Buffer.from(sign(parts[0]))
          const supplied = Buffer.from(parts[1])
          if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error()
          value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))
          if (value.query !== query || value.limit !== limit || !Number.isSafeInteger(value.after) || value.after <= 0 || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error()
        } catch { throw new ApiError("invalid_cursor", "Cursor is malformed or does not match this query and limit.") }
        if (value.revision !== currentRevision) throw new ApiError("stale_cursor", "Collection changed. Restart search.", 409)
        after = value.after
      }
      const rows = sqlQuery(`SELECT ${columns.split(", ").map((column) => `d.${column}`).join(", ")} FROM documents d
        JOIN document_tokens t ON d.id = t.document_id
        WHERE d.active = 1 AND d.id > ? AND t.token IN (${tokens.map(() => "?").join(",")})
        GROUP BY d.id HAVING COUNT(DISTINCT t.token) = ? ORDER BY d.id LIMIT ?`)
        .all(after, ...tokens, tokens.length, limit + 1) as DocumentRow[]
      const page = rows.slice(0, limit)
      const results: SearchResult[] = page.map((row) => {
        const citation = excerpt(row, tokens)
        return { id: row.id, source: row.source, title: row.title, version: row.version, snippet: citation.quote, citation }
      })
      return { query, revision: currentRevision, results, nextCursor: rows.length > limit ? cursorFor(query, limit, currentRevision, page.at(-1)!.id) : null }
    })()
  }

  return {
    revision,
    import(value: unknown) { return importMany([value])[0] },
    importMany,
    batch,
    list() { return sqlQuery(`SELECT ${columns} FROM documents WHERE active = 1 ORDER BY id`).all() as DocumentRow[] },
    collection() { return db.transaction(() => ({ documents: this.list(), revision: revision() }))() },
    get,
    historical,
    versions(id: number) {
      return sqlQuery("SELECT version, title, created_at FROM document_versions WHERE document_id = ? ORDER BY version").all(id) as Pick<DocumentRow, "version" | "title" | "created_at">[]
    },
    citation,
    searchPage,
    search(query: string) { return searchPage(query, 50).results },
    close() {
      for (const statement of statements.values()) statement.finalize()
      statements.clear()
      db.close(true)
    },
  }
}

export type Store = ReturnType<typeof openStore>
