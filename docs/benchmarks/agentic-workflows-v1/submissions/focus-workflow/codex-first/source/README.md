# Workflow Runner

A local workflow dashboard built on the original jobs queue. The v1 jobs table and legacy HTTP responses remain intact. Schema v2 adds workflow graphs, attempt history, idempotency records and ordered events in SQLite transactions.

Run with the installed, pinned dependencies:

```powershell
$env:PORT = '4123'
$env:DATA_DIR = Join-Path $env:TEMP 'my-workflow-runner'
bun run build
bun run start
```

Open `http://127.0.0.1:4123`. The server binds only to loopback. `bun run start` continues to invoke `server/index.ts`; it serves the built dashboard from `dist/index.html`, with the authored `public/index.html` as a fallback before a build. Builds write only to `dist`.

`DATA_DIR/workflow.sqlite` holds the database. If `DATA_DIR` is unset, it defaults to the OS temporary directory's `workflow-runner-data` folder, outside the source tree. Set it to a dedicated persistent directory for ongoing use. `WORKFLOW_MARKER_DIR` defaults to `DATA_DIR/markers`. `WORKFLOW_CONCURRENCY` sets the shared worker limit from 1 to 3 (default 2); workflow concurrency imposes a further limit. `WORKFLOW_WORKER_PATH` defaults to the supplied `server/worker.ts` fixture. Blocking fixture jobs wait for a client-controlled `<job-id>.<attempt>.release` file in the marker directory, or can be cancelled from their workflow card.

Create workflows with `POST /api/workflows` and a fresh `Idempotency-Key`. The form generates that key per submission. Equivalent JSON objects replay the same workflow, including after restart; changing content under the same key returns 409. Lists and details are available at `/api/workflows` and `/api/workflows/:id`; `/events?after=0` provides the durable event stream, and `POST /cancel` cancels a workflow and waits for its workers to exit. The original `/api/jobs` list/create and `/api/jobs/:id` detail routes remain available.

On restart, unfinished attempts become interrupted and recover with increasing attempt numbers. Interruptions do not spend the failure allowance. Completed jobs are never rerun. Recovery provides **at least once** execution: external side effects need their own idempotency. Run one server per data directory; distributed execution and concurrent server ownership of one database are outside this local runner's scope.

Verification commands:

```powershell
bun run typecheck
bun run build
bun test tests
```

Tests retain the supplied smoke test and exercise real subprocess markers, dependency order, retries, limits 1/2/3, cancellation, crash recovery, migration rollback and durable idempotency. They create and remove their own disposable OS temporary directories. Application code never writes fixture start/finish/release evidence. Browser verification uses the supplied local driver on the configured port, with desktop and 390px mobile viewports.
