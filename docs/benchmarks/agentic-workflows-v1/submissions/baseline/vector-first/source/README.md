# Workflow Runner

A local Bun/SQLite dashboard with durable dependency workflows and the original
single-job API. The supplied v1 schema, worker and smoke test remain unchanged.

## Run

```sh
bun run typecheck
bun run build
bun test tests
PORT=8088 DATA_DIR=/path/to/disposable-data bun run start
```

The server listens only on `127.0.0.1` and serves the browser dashboard at `/`.
`DATA_DIR/workflow.sqlite` is migrated transactionally to schema version 2.
Completed v1 rows are left untouched. Unfinished v1 work is adopted by the runner.
Without `DATA_DIR`, data is stored in the system temporary directory under
`workflow-runner`, never in authored source. Builds write only to `dist`.

Configuration:

- `PORT`: HTTP port, default `8088`.
- `WORKFLOW_CONCURRENCY`: global live-worker limit, 1 to 3, default 2. Each
  workflow's concurrency is a separate additional bound.
- `WORKFLOW_WORKER_PATH`: worker executable script, default `server/worker.ts`.
- `WORKFLOW_MARKER_DIR`: fixture evidence directory, default `DATA_DIR/markers`.
  The app never writes worker evidence or release files.

## Behavior

Create workflows with `POST /api/workflows` and an `Idempotency-Key`. Keys and
canonical JSON request identities persist in SQLite. Object property ordering
does not affect identity; array ordering does. Inspect workflows at
`GET /api/workflows/:id`, events at `/api/workflows/:id/events?after=0`, and cancel
using `POST /api/workflows/:id/cancel`. The original `/api/jobs` API is preserved.

Failed attempts retry up to the configured failure allowance. On restart,
unfinished attempts become `interrupted`; recovery uses a fresh attempt number
without spending the failure allowance. Execution across crashes is **at least
once**, not exactly once for external side effects. Completed work is not rerun.
Cancellation prevents further dispatch and waits for that workflow's live
children to exit before responding. It does not affect other workflows.

The dashboard polls real backend data every 700 ms, shows attempt history and
inline ordered events, and renders names and errors as text. `block` jobs wait
for release files controlled by the worker's caller or can be cancelled.

## Verification

`bun test tests` runs the protected smoke test and real subprocess integration
tests for migration, legacy compatibility, validation, idempotency, events,
dependency ordering, global/per-workflow concurrency, retry exhaustion,
cancellation, and crash recovery. Tests use disposable data outside source.

Local Chrome verification also exercised desktop and 390 px mobile layouts,
creation, retry history, errors, external-client updates, keyboard selection,
cancellation, and inline events. Verification screenshots and browser scripts
are kept outside source. This is a local single-server runner, not a hosted or
authenticated multi-user service.
