# Support desk

A local support dashboard with persistent drafts and an explicit transactional delivery outbox. All tickets and replies are synthetic.

Use the pinned Bun 1.3.14 and Node 24.22.0 installations. Set `DATA_DIR` to an absolute directory outside this application, then run `bun server/index.ts`. The server binds only to `127.0.0.1` and uses `PORT` (default 4123). The protected fake provider runs once in the same process; its loopback origin is available from `/api/health`.

Save a draft, queue it, then press **Process queue**. Admission commits the immutable body, provider key and recoverable work together in SQLite before responding; admission never sends. A drain takes a snapshot of queued or unfinished sending messages and attempts each once. Concurrent drains coalesce. A failed attempt needs **Retry**, then **Process queue**; retry keeps the same envelope and provider key. Startup does not transmit. The next explicit drain recovers interrupted sending work by replaying the same envelope, which also reconciles a receipt committed before a crash.

Cancellation is local only when no send attempt has started. Otherwise the app asks the provider to atomically cancel the key or return its receipt. A receipt confirms delivery and preserves a too-late cancellation explanation. Failed cancellation remains unresolved; retry and drain reattempt cancellation rather than sending. Late responses re-read the committed state before settling it. A provider request times out after 60 seconds into an unresolved state.

`support.sqlite` and the provider database live under `DATA_DIR`, using SQLite WAL and durable writes. The messages row is the outbox work record; the admission table gives request IDs a durable, unique message owner. Message bodies are immutable after admission. Details show the key, attempts, receipt, cancellation intent and verbatim error. **Refresh** reloads committed state. Selecting another ticket preserves its unsaved composer in the current page session.

Checks: `bun run typecheck` and `bun test tests`. Tests start one app at a time on the supplied `PORT`, use isolated directories under `DATA_DIR`, exercise the public provider controls, hard-stop their own processes, and remove their temporary databases. Keep other app instances stopped while running the tests. No external services or deployment are needed.
