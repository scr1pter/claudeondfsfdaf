# Evidence Workbench

Local Markdown and plain-text research, with literal ASCII token search. Imported
content is always displayed as text. No external services or accounts are used.

## Run

```sh
bun run typecheck
bun test tests
bun run build
PORT=4123 DATA_DIR=.data bun server/index.ts
```

In PowerShell, set `$env:PORT` and `$env:DATA_DIR` before running the server.
The direct entrypoint binds to loopback and serves `dist`. The database is always
`DATA_DIR/workbench.sqlite`; keep that directory across restarts.

## Storage and API

Opening a legacy database migrates it transactionally to schema version 2. Logical
documents retain their IDs across replacement, deletion, and revival. Original
versions remain available independently of current document state.

`POST /api/batches` accepts a batch header and 1–128 upsert/delete operations as
`application/x-ndjson`. Validation finishes before the write transaction starts.
Version history, token index, collection revision, and receipt commit together.
Retry an accepted batch ID to retrieve its original receipt; use a new ID for new
operations. `POST /api/import` still accepts JSON or document NDJSON.

Read routes provide active documents, immutable historical versions, paginated
search, byte-range citations, and schema/revision health. Search cursors are signed
and bind the exact query, page size, collection revision, and continuation ID.
The signing key persists in SQLite. Material changes invalidate earlier cursors;
no-op writes and receipt replay preserve them.

Search excerpts preserve exact UTF-8 slices and contain at most 512 bytes. If every
matching body token is longer than 512 bytes, containing a whole matching token
and respecting that cap is impossible. In that case the excerpt preserves the
cap and quotes the beginning of the first matching token. When a shorter matching
token exists, the excerpt includes it whole.

## Verification

Tests cover legacy migration, immutable versions, delete/revival, canonical
receipts, restart persistence, transaction rollback with an injected SQLite
failure, validation, pagination, stale cursors, exact Unicode byte ranges, and the
HTTP contract. Verification databases, browser scripts, and observations belong
outside application source; local manual verification uses `.verification`.
