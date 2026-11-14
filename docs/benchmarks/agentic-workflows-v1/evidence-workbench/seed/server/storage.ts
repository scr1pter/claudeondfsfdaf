import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { documentInput, terms } from "./types"
import type { DocumentInput, DocumentRow } from "./types"

export function openStore(directory: string) {
  mkdirSync(directory, { recursive: true })
  const db = new Database(join(directory, "workbench.sqlite"), { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS document_tokens (
    document_id INTEGER NOT NULL, token TEXT NOT NULL,
    PRIMARY KEY (document_id, token)
  ); CREATE INDEX IF NOT EXISTS document_tokens_lookup ON document_tokens (token, document_id);
  PRAGMA user_version = 1`)

  function index(row: DocumentRow) {
    db.query("DELETE FROM document_tokens WHERE document_id = ?").run(row.id)
    const insert = db.query("INSERT INTO document_tokens (document_id, token) VALUES (?, ?)")
    terms(row.title + " " + row.body).forEach((token) => insert.run(row.id, token))
  }
  const save = db.transaction((input: DocumentInput) => {
    db.query(`INSERT INTO documents (source, title, body, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET title = excluded.title, body = excluded.body`)
      .run(input.source, input.title, input.body, new Date().toISOString())
    const row = db.query("SELECT * FROM documents WHERE source = ?").get(input.source) as DocumentRow
    index(row)
    return row
  })
  // Also permit opening earlier v1 files that predate the lexical token table.
  db.transaction(() => (db.query("SELECT * FROM documents").all() as DocumentRow[]).forEach(index))()

  return {
    import(value: unknown) {
      return save(documentInput(value))
    },
    list() {
      return db.query("SELECT * FROM documents ORDER BY id").all() as DocumentRow[]
    },
    get(id: number) {
      return db.query("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | null
    },
    search(query: string) {
      const tokens = terms(query)
      if (!tokens.length) return []
      const rows = db.query(`SELECT documents.* FROM documents
        JOIN document_tokens ON documents.id = document_tokens.document_id
        WHERE document_tokens.token IN (${tokens.map(() => "?").join(",")})
        GROUP BY documents.id HAVING COUNT(DISTINCT document_tokens.token) = ?
        ORDER BY documents.id`).all(...tokens, tokens.length) as DocumentRow[]
      return rows.map((row) => ({ ...row, snippet: row.body.slice(0, 180) }))
    },
    close() { db.close() },
  }
}
