# Workflow Runner

A local Bun + SQLite dashboard. The original jobs table and `/api/jobs` API are preserved; workflows add dependency graphs, subprocess execution, concurrency bounds, retries, cancellation, and durable attempt/event history.

## Run

Use the installed, pinned dependencies. Build with `bun run build`, then start with `bun run start` (the entrypoint remains `bun server/index.ts`). It listens only on `127.0.0.1` and serves the dashboard without external resources.

Set `PORT` (default `8088`) and `DATA_DIR` to a durable directory outside source. SQLite uses `DATA_DIR/workflow.sqlite`; without `DATA_DIR`, the default is the operating system's temporary directory under `workflow-runner-local` (supply a durable directory for long-term retention).

Optional settings:

- `WORKFLOW_CONCURRENCY`: global live-worker bound, `1`–`3`, default `2`. Each workflow's concurrency is an additional bound.
- `WORKFLOW_WORKER_PATH`: defaults to the preserved `server/worker.ts`.
- `WORKFLOW_MARKER_DIR`: defaults to `DATA_DIR/markers`. Only the worker writes start/finish evidence. A `block` worker waits for its `<job-id>.<attempt>.release` file; its caller controls release.

## Durability

Startup migrates v1 in one SQLite transaction and records schema version 2 only on success. Completed legacy rows remain unchanged. The legacy API lists legacy jobs; workflow nodes have their own inspection API. Each new legacy job is scheduled as an internal one-node workflow.

Jobs start only after every predecessor succeeds. Failures retry up to `maxAttempts` (default 1), then block descendants. Independent branches continue. Events and attempt transitions commit together. Cancellation prevents further dispatch, kills and reaps this workflow's children, and commits its terminal state before responding.

After a crash, unfinished attempts become `interrupted`; a new numbered attempt can run without consuming an additional failure allowance. Successful nodes never rerun. Execution is **at least once** across crashes: external worker side effects must tolerate repetition. Recovery never signals saved PIDs, which might have been reused. The protected worker detects parent disappearance.

Creation requires `Idempotency-Key`. Identity compares the original JSON recursively with object properties sorted and array order retained. The key and identity are stored transactionally with the workflow; replays return its current state without writing events.

The browser polls real APIs every 800ms. Event logs stay inline, and user-provided names, output, and errors are rendered as text. Worker results are trimmed stdout; stored failure messages are bounded to 4,000 characters.

## Verify

```text
bun run typecheck
bun run build
bun test tests
```

Integration tests launch disposable local servers and real workers. They cover migration and rollback, validation atomicity, idempotency/restart, DAG ordering, retries and exhaustion, concurrency bounds 1–3, cancellation, event cursors/isolation, and crash recovery. Databases and process evidence stay under ignored `.verification/tests`, outside authored source. Tests stop their servers and wait for workers to exit; evidence remains available for inspection.

For the browser checks, launch a separate disposable instance on `PORT` with `DATA_DIR` under `.verification`, then run `scripts/verify-browser.mjs` with the installed `NODE_EXE`. It uses `PLAYWRIGHT_MODULE` and `CHROME_PATH`, checks desktop and 390px layouts, keyboard controls, real create/retry/cancel/event flows, cross-client updates, legacy jobs, and text safety. Reports and screenshots are written under `.verification/browser`. It closes its browser; stop the server you started afterward. The supplied common browser driver can also inspect that same local URL.

The runner assumes one server owns each data directory. It provides local execution and polling, without multi-server coordination or exactly-once external side effects.
