# Workflow Runner

A local SQLite-backed workflow dashboard with a preserved v1 job API.

## Run

Use the pinned dependencies with Bun. Set `PORT` and `DATA_DIR`, then run:

```sh
bun run typecheck
bun run build
bun test tests
bun run start
```

The server binds only to `127.0.0.1` and serves the dashboard at `/`. Set
`DATA_DIR` to an existing v1 database directory to upgrade it in place. The
database is `DATA_DIR/workflow.sqlite`; the schema upgrade is transactional.
Completed legacy rows are not rewritten or rerun. Back up existing databases
before an upgrade.

Runtime data should be outside the source tree. Without `DATA_DIR`, the default
is `../workflow-data` relative to the app root. `WORKFLOW_MARKER_DIR` defaults to
`DATA_DIR/markers`. `WORKFLOW_CONCURRENCY` is 1-3, default 2, and each workflow
also limits its own concurrency. `WORKFLOW_WORKER_PATH` optionally overrides
the supplied worker. Authored source never belongs in generated `dist`.

## Semantics

- Run one server process per database. The concurrency bound belongs to that
  runner, not to a distributed fleet.
- Dependencies must all succeed before a job starts. Exhausted failures block
  descendants, not independent work.
- Failed attempts count toward `maxAttempts`; interrupted attempts do not.
  Recovery is **at least once**, so external side effects must tolerate repeats.
- Cancellation first persists its intent, prevents dispatch, kills and reaps
  owned workers, then records a terminal workflow. Completed results survive.
- Workflow creation requires an `Idempotency-Key`. Identity uses the submitted
  JSON with sorted object keys and significant array ordering. Keys and events
  persist in SQLite.
- Events are available at `/api/workflows/:id/events?after=0`. The dashboard
  polls backend state every 750 ms, including open inline event histories.
- The `block` fixture waits for a test-controlled release file. Application
  code never creates worker evidence or releases.

## Verification

`bun test tests` includes the unchanged smoke fixture plus real-process tests
for migration, legacy compatibility, atomic validation, canonical idempotency,
dependency ordering, global/per-workflow bounds, retries, blocking, cancellation,
event cursors, and crash/restart recovery. Tests use disposable OS temporary
directories and stop their own servers.

The dashboard is plain local HTML/CSS/JavaScript with native labelled controls,
text-only rendering of user data, responsive cards and contained scrollable
history panels. No CDN or hosted service is used. This is a local development
runner, not an authenticated multi-user or distributed execution service.
