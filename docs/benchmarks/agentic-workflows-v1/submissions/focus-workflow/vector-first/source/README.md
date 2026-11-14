# Workflow Runner

A loopback-only Bun/SQLite job dashboard. Existing v1 jobs and the `/api/jobs` HTTP API are retained. New single jobs use the same subprocess scheduler as workflows.

## Run

```powershell
$env:PORT = '4123'
$env:DATA_DIR = '<outside-source-data-directory>'
bun run build
bun run start
```

Open `http://127.0.0.1:4123`. Startup transactionally installs schema v2 in `DATA_DIR/workflow.sqlite` before serving requests. Existing completed v1 records are not modified or executed. Unfinished v1 records are adopted into one-node workflows. Back up a real database before upgrading it; verification uses disposable databases only.

- `WORKFLOW_CONCURRENCY`: global live-worker limit, integer 1-3, default 2. Workflow concurrency imposes an additional limit.
- `WORKFLOW_WORKER_PATH`: defaults to `server/worker.ts`.
- `WORKFLOW_MARKER_DIR`: defaults to `DATA_DIR/markers`; only the worker writes execution evidence. Tests write explicit release files for blocking fixture jobs.
- Without `DATA_DIR`, runtime data defaults to the OS temporary directory's `workflow-runner` folder. Configure a durable directory for normal use.
- Build copies the browser app into generated `dist/index.html`; startup serves it, falling back to `public/index.html` before the first build. Builds write only `dist`.

## Behavior

`POST /api/workflows` requires an `Idempotency-Key`. Its JSON body contains `name`, `concurrency`, and a `jobs` array. Each job has `key`, `name`, `kind`, optional `dependsOn` and optional `maxAttempts`. The dashboard includes an editable example.

Workflow state, dependency edges, attempts, idempotency request identities and ordered per-workflow events are persisted in SQLite. Request identities sort object keys recursively while preserving array order. Validation and creation are atomic. The original jobs table remains intact; newly executed legacy jobs update its original response fields.

The scheduler spawns the supplied Bun worker with persisted IDs, attempt numbers, marker directory and parent PID. Dependencies require success; exhausted failures block descendants without stopping independent work. Cancellation stops and reaps only owned subprocesses before responding. Restart records unfinished attempts as interrupted and gives recovered work a new attempt number without using a failure allowance. Completed work is not repeated.

**Recovery is at least once, not exactly once.** A subprocess may have performed external side effects before a crash. This local runner has no authentication and is intentionally bound to `127.0.0.1`; it is not a hosted service or an arbitrary-command execution interface.

## Verify

```powershell
bun run typecheck
bun run build
bun test tests
```

The preserved smoke test and integration tests cover v1 migration, legacy execution, request validation, idempotency across restart, event cursors, actual worker evidence/PIDs, global limits 1-3, per-workflow concurrency, dependency ordering, retries/exhaustion, blocking, cancellation/isolation and crash recovery. Their databases and marker files are disposable OS-temp data.

For browser checks, start an isolated app with outside-source `DATA_DIR`, then use the installed local tools:

```powershell
$env:VERIFICATION_DIR = '<outside-source-artifact-directory>'
& $env:NODE_EXE scripts/browser-check.mjs
```

This requires `PLAYWRIGHT_MODULE` and `CHROME_PATH`, uses `PORT`, and never installs a browser. It verifies desktop and 390px layouts, creation/validation, retry history, backend event order, cross-client polling, failure alerts, text-only rendering, cancellation, legacy jobs, keyboard select operation, reload persistence and no outside app requests/JavaScript errors. Screenshots and JSON results go only to `VERIFICATION_DIR`. Stop the verification server afterward.
