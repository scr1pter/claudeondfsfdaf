# Evidence Workbench: durable document revisions

This is a local research workbench for synthetic Markdown and text documents. The
working v1 imports JSON or NDJSON, stores documents in SQLite, searches literal
lexical tokens, and displays original text in a browser. Maintain that application
while adding trustworthy document revisions, atomic batches, citations, and
pagination. Implement the feature across storage, HTTP API, and the browser UI.
Use no models, embeddings, cloud services, accounts, PDF libraries, or network
dependencies. All data and dependencies needed for this task are local.

Run `bun run typecheck`, `bun test tests`, and `bun run build` from this app.
`PORT=4123 DATA_DIR=<directory> bun server/index.ts` serves the built app on loopback.
Keep `server/index.ts` as the direct server entrypoint; `bun run start` is also a
convenience script. The evaluator owns the direct server process for restarts.
Use the supplied common browser client for browser inspection; its CLI path and
local endpoint are provided by the coding runner. The client is the only benchmark
helper outside the app that the coding agent may access. Do not edit `TASK.md`,
`tests/smoke.test.ts`, `schema/legacy.sql`, or `bun.lock`. Keep the pinned dependency
versions. Only `dist` is declared generated output. Do not fetch dependencies or
inspect evaluator files. You may add your own app tests.

## Durable document model

Keep `DATA_DIR/workbench.sqlite` as the database. Automatically migrate a database
created from `schema/legacy.sql`: preserve every document ID, source, title, body,
and creation timestamp. Each existing document becomes version 1. A fresh database
starts at collection revision 0; migration of a nonempty legacy database produces
revision 1 (an empty legacy database produces 0). Health returns
`{ok:true,schemaVersion:2,revision:<nonnegative integer>}`. Restart must preserve
documents, version history, collection revision, and batch receipts.

A source identifies one logical document. Its positive integer ID stays the same
across replacement, deletion, and revival. Upserting changed title or body creates
the next contiguous positive version; an exact current upsert is a no-op. Versions
are immutable and contain the complete original Unicode text. Deleting an active
source removes its current document and current search hits but retains all
historical versions. Repeated deletion and deletion of an unknown source are
no-ops. Revival uses the same ID and the next version number. Every operation in a
batch sees preceding operations only after whole-request validation; a source may
appear at most once in one batch.

The collection revision increments exactly once for a committed request containing
at least one material document change, irrespective of the number of operations.
No-op, rejected, and replayed requests do not increment it. All effects of a batch,
including its receipt and revision, commit in one SQLite transaction. A failure
must leave no partial document, version, search-index, or receipt changes.

## Batch protocol

Add `POST /api/batches` accepting UTF-8 `application/x-ndjson`. Its first nonblank
line is `{"type":"batch","batchId":"sample_01"}`. Following nonblank lines
are 1–128 operations of either shape:

```json
{"type":"upsert","source":"notes/fern.md","title":"Fern log","body":"# Field log\nCafé 🧭 amber fern."}
{"type":"delete","source":"notes/old.md"}
```

Accept LF or CRLF and ignore blank lines. `batchId` must match
`[A-Za-z0-9_-]{1,80}`. A source is a nonblank string of at most 200 Unicode scalar
values without U+0000–U+001F. A title is a nonblank string of at most 200 Unicode
scalar values. Body must be a string with no U+0000 and at most 1,048,576 UTF-8
bytes. Reject unpaired surrogates. These constraints apply to the legacy importer
as well. Unknown object properties may be ignored. Do not trim or normalize
accepted source, title, or body values. Invalid JSON, missing/extra headers,
unknown operation types, invalid fields, duplicate sources, or too many/few
operations return 400 with `error.code = "invalid_batch"`. Validation must precede
all writes. Include a useful message; do not expose internal SQL or stack traces.

A first valid batch returns 201:

```json
{"batchId":"sample_01","revision":1,"replayed":false,"operations":[{"type":"upsert","source":"notes/fern.md","documentId":1,"version":1,"changed":true}]}
```

Operations stay in request order. A delete reports `version:null`; an unknown
source reports `documentId:null`. A no-op active upsert reports the existing ID
and version. Retrying the same batch ID with the same accepted fields and
operation order returns 200 and the original receipt with `replayed:true`, even
after subsequent changes. JSON key order, whitespace, CRLF/LF, and ignored extra
properties do not change batch identity. Reusing an ID for different accepted
fields or order returns 409 `batch_conflict` and changes nothing. Persist receipts
across restarts. A valid no-op batch still reserves its ID and gets a receipt.

Preserve `POST /api/import` with either one JSON `{source,title,body}` or NDJSON
containing those objects (no batch header). It returns 201 `{documents:[...]}`.
It must use the same version model and validate a whole request before writing.
Each returned document includes `id,source,title,body,created_at,version`.

## Read API and lexical search

Keep `GET /api/documents` as `{documents:[...],revision}` sorted by ID, active only.
`GET /api/documents/:id` returns `{document:{id,source,title,body,created_at,version}}`
for an active document, or 404 `not_found`. Add
`GET /api/documents/:id/versions` as `{versions:[{version,title,created_at},...]}`
in ascending version order, and `GET /api/documents/:id/versions/:version` returning
the full historical `{document:...}` even after deletion. No read creates state.

`GET /api/search?q=<query>&limit=<n>&cursor=<opaque>` searches only active versions
and returns `{query,revision,results,nextCursor}`. `query` is the input query
unchanged. Query terms are the distinct lowercase ASCII `[a-z0-9]+` runs in the
query. A document matches when every term occurs as a whole ASCII token in its
title or body combined. ASCII runs define tokens even inside surrounding Unicode;
there is no stemming, fuzzy matching, stop list, or accent folding. Zero or more
than eight distinct terms returns 400 `invalid_query`. Sort by document ID
ascending, deterministically. Default limit is 10; accept integers 1–50 and reject
other limits with 400 `invalid_limit`. Do not silently truncate or round.

Each result contains `id,source,title,version,snippet,citation`. A citation is
`{documentId,version,startByte,endByte,quote}` bound to that immutable version.
Offsets are zero-based UTF-8 bytes into the stored body, start inclusive and end
exclusive, on Unicode scalar boundaries. `quote` must equal that exact byte slice;
`snippet` equals `quote`. Use a deterministic excerpt of at most 512 UTF-8 bytes.
For a body containing a query token, the excerpt must include a whole matching
token. For title-only matches, quote the first available body text (an empty body
has offsets 0,0 and an empty quote). Preserve case, punctuation, newlines, composed
and decomposed accents, emoji, and non-Latin text exactly. JavaScript UTF-16 string
indices are not byte offsets.

The opaque `nextCursor` is null at the end. It binds the collection revision,
the exact query string, limit, and continuation position. It must visit each hit
once with no duplicates or gaps. Malformed or query/limit-mismatched cursors return
400 `invalid_cursor`. When a material write has advanced the revision, a formerly
valid cursor returns 409 `stale_cursor`, including when its remaining hits were
unaffected. A replay or no-op must leave the cursor usable. Do not quietly restart
pagination or return a mixed revision.

Add `GET /api/citations?documentId=<id>&version=<n>&startByte=<s>&endByte=<e>`
returning the citation object directly. Validate positive integer IDs/versions and
nonnegative integer offsets, ordered and within the stored body's UTF-8 bytes.
Reject ranges cutting through a multibyte scalar with 400 `invalid_range`, invalid
or missing parameters with 400 `invalid_range`, and unknown IDs/versions with 404
`not_found`. Empty ranges on scalar boundaries are valid. Citations continue to
resolve after replacement/deletion. All API errors use
`{error:{code:<string>,message:<string>}}` and appropriate HTTP statuses.

## Browser behavior

Keep the existing single-document importer, search, and original-text viewer.
Provide the following exact visible accessible names and stable test IDs. Use
ordinary page sections, with no modal dialogs and no required file upload:

* A textarea named **Batch NDJSON** and button **Import batch**. A visible
  `role="status"` reports the batch ID, revision, and replay outcome, or a useful
  validation error. Failed import must not erase the entered text.
* Existing text fields **Document source**, **Document title**, **Document text**
  and button **Import document** continue to work.
* A textbox **Search documents**, button **Search**, list **Search results**, and
  one `data-testid="search-result"` per hit. Each hit has its source/title and
  buttons **Open document {id}** and **View citation {id}**.
* A **Results per page** select with values `2`, `10`, `25` (default `10`), and
  **Next results** button, disabled or absent at the end. If the server reports a
  stale cursor, show a visible message containing “Collection changed” and a
  **Restart search** button; do not append mixed-revision results. Restart begins
  at the current revision with the same query and selected page size.
* Document detail includes exact original text in `data-testid="document-body"`,
  a **Document version** select whose values are version numbers, and a visible
  version label. Selecting a historical version displays its original text.
* Citation detail contains `data-testid="citation-quote"`, its version and both
  byte offsets as visible text, and **Open cited document**. This opens the exact
  cited immutable version, including after its source was replaced or deleted.

Imported titles, sources, bodies, snippets, and quotes are untrusted text. Display
them as text; imported HTML, Markdown links, script tags, images, and event
attributes must never execute, become active resources, or alter the app DOM.
Do not render imported Markdown as HTML. Keep the app usable at desktop and
390-pixel viewport widths. Data and version selection must survive a server
restart through the durable APIs; transient browser form state need not persist.

Deliver the working implementation and any meaningful tests. The independent
acceptance suite tests this public contract with deterministic synthetic data;
implementation architecture is your choice.
