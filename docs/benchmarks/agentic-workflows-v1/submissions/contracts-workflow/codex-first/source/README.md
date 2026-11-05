# Workflow Runner

A local SQLite workflow dashboard with real Bun child processes. The original
`jobs` table and legacy HTTP response fields remain intact. The v1 SQL, worker,
smoke test, pinned dependencies, and lockfile are preserved.

Run from the application directory:

```powershell
$env:PORT = '4123'
$env:DATA_DIR = Join-Path ([System.IO.Path]::GetTempPath()) 'my-workflow-runner'
bun run build
bun run start
```

The server binds to `127.0.0.1`. Open the displayed local address. The browser
uses local assets and polls backend state every second. `bun run start` serves
the app without a separate development server.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8088` | HTTP port |
| `DATA_DIR` | OS temporary directory + `workflow-runner` | Contains `workflow.sqlite` |
| `WORKFLOW_CONCURRENCY` | `2` | Global live worker limit, integer 1–3 |
| `WORKFLOW_WORKER_PATH` | Absolute path to `server/worker.ts` | Worker entrypoint |
| `WORKFLOW_MARKER_DIR` | `DATA_DIR/markers` | Evidence written by the worker fixture |

Choose a persistent `DATA_DIR` outside the source tree to retain work beyond OS
temporary-file cleanup. The application never writes fixture evidence or release
files. A `block` worker waits for its release file; it is also terminable through
workflow cancellation.

`server/store.ts` migrates v1 inside a durable transaction and links existing
legacy rows to single-node workflows without rewriting completed rows. Additional
tables store workflow nodes, attempts, ordered events, and canonical idempotency
requests. `server/runner.ts` enforces both concurrency bounds, resolves dependencies,
and retains each attempt. All persisted state transitions and their events commit
together. Legacy workflows are shown in the legacy region and `/api/jobs`;
workflows created through `/api/workflows` appear in the workflow list.

Cancellation durably prevents dispatch before terminating and awaiting that
workflow's children. On startup, unfinished attempts become interrupted and are
retried with increasing attempt numbers. Interrupted attempts do not consume the
failure allowance. Completed jobs never rerun. Crash recovery provides **at least
once** execution; external side effects in a custom worker must tolerate repeats.
Recovery does not signal persisted PIDs.

Workflow creation requires an `Idempotency-Key`. Object keys are canonicalized
recursively; array order remains significant. Validation finishes before any rows
or events are inserted. Replays read existing state without adding events.

Checks:

```powershell
bun run typecheck
bun run build
bun test tests
```

The integration tests launch real servers and workers in disposable OS temporary
directories. They cover v1 migration, the legacy API, validation atomicity,
idempotency, event cursors, dependency order, successful retries, exhausted retries,
blocking, global limits 1/2/3, per-workflow limits, cancellation and child reaping,
and crash recovery. Tests write only release controls; start/finish evidence is
produced by the preserved worker. Builds write generated files only under `dist`.
