-- The installed v1 schema. Existing document IDs must survive a v2 migration.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_tokens (
  document_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (document_id, token)
);
CREATE INDEX IF NOT EXISTS document_tokens_lookup ON document_tokens (token, document_id);
PRAGMA user_version = 1;
